import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { accountProviderContext } from "../src/account-library";
import { MAX_FAVORITES } from "../src/favorites";
import { refreshPrimaries } from "../src/versions";

let serial = 0;
async function user(role: "admin" | "user" = "user", maxAge: number | null = null) {
  const created = await db.user.create({ data: { email: `favorites-${serial++}@example.invalid`, displayName: role === "admin" ? "Server owner" : "Family member", hashedPassword: "fixture-no-password-auth", role, maxAge } });
  return { ...created, token: signSession({ sub: created.id, email: created.email, role, version: created.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
async function item(owner: User, name: string, extra: Record<string, unknown> = {}) {
  await db.debridConfig.upsert({ where: { userId: owner.id }, create: { userId: owner.id, realDebridToken: "private-fixture-key" }, update: {} });
  const ctx = await accountProviderContext(owner.id, "realdebrid");
  return db.accountMedia.create({ data: { userId: owner.id, provider: "realdebrid", providerRef: `ref-${serial++}`, credentialFingerprint: ctx.fingerprint, name, year: 2020, type: "movie", phase: "finished", progress: 100, groupKey: `title:${name}`, minAge: 0, ratingLabel: "G", ...extra } });
}
async function library(owner: User, members: User[] = []) {
  const created = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Family movies", mediaType: "movie" });
  expect(created.status).toBe(201);
  for (const member of members) expect((await request(app).post(`/api/admin/shared-libraries/${created.body.library.id}/users`).set(auth(owner.token)).send({ userId: member.id })).status).toBe(200);
  return created.body.library.id as string;
}
const url = (libraryId: string, itemId: string) => `/api/shared-libraries/${libraryId}/items/${itemId}/favorite`;
const mine = (viewer: User) => request(app).get("/api/shared-libraries/favorites").set(auth(viewer.token));

beforeEach(async () => { await resetDb(); });

it("puts a title on the viewer's own list, shows it as listed everywhere, and takes it off again", async () => {
  const owner = await user("admin"), viewer = await user(), film = await item(owner, "Example Movie"), other = await item(owner, "Other Movie");
  const libraryId = await library(owner, [viewer]);
  expect((await mine(viewer)).body.items).toEqual([]);
  const added = await request(app).put(url(libraryId, film.id)).set(auth(viewer.token));
  expect(added.status).toBe(200); expect(added.body).toEqual({ favorite: true });
  expect((await request(app).put(url(libraryId, film.id)).set(auth(viewer.token))).status).toBe(200); // adding twice is fine
  const list = await mine(viewer);
  expect(list.body.items).toHaveLength(1); expect(list.body.items[0]).toMatchObject({ libraryId, item: { id: film.id, name: "Example Movie", favorite: true } });
  expect(JSON.stringify(list.body)).not.toMatch(/providerRef|credentialFingerprint|private-fixture-key/);
  const page = await request(app).get(`/api/shared-libraries/${libraryId}/items`).set(auth(viewer.token));
  expect(page.body.items.find((row: { id: string }) => row.id === film.id).favorite).toBe(true); expect(page.body.items.find((row: { id: string }) => row.id === other.id).favorite).toBe(false);
  expect((await request(app).get(`/api/shared-libraries/${libraryId}/items/${film.id}`).set(auth(viewer.token))).body.item.favorite).toBe(true);
  const removed = await request(app).delete(url(libraryId, film.id)).set(auth(viewer.token));
  expect(removed.body).toEqual({ favorite: false }); expect((await request(app).delete(url(libraryId, film.id)).set(auth(viewer.token))).status).toBe(200);
  expect((await mine(viewer)).body.items).toEqual([]);
  expect((await request(app).get(`/api/shared-libraries/${libraryId}/items/${film.id}`).set(auth(viewer.token))).body.item.favorite).toBe(false);
});

it("lists newest first and keeps each viewer's list their own", async () => {
  const owner = await user("admin"), alice = await user(), bob = await user(), first = await item(owner, "First"), second = await item(owner, "Second");
  const libraryId = await library(owner, [alice, bob]);
  await request(app).put(url(libraryId, first.id)).set(auth(alice.token));
  await new Promise(done => setTimeout(done, 15));
  await request(app).put(url(libraryId, second.id)).set(auth(alice.token));
  expect((await mine(alice)).body.items.map((row: { item: { name: string } }) => row.item.name)).toEqual(["Second", "First"]);
  expect((await mine(bob)).body.items).toEqual([]);
  expect((await request(app).get(`/api/shared-libraries/${libraryId}/items/${first.id}`).set(auth(bob.token))).body.item.favorite).toBe(false);
  expect((await request(app).get("/api/shared-libraries/favorites")).status).toBe(401);
});

it("treats every version of a title as one entry and lists the version the library shows", async () => {
  const owner = await user("admin"), viewer = await user(), key = "imdb:tt0111161";
  const older = await item(owner, "Example Movie", { groupKey: key, createdAt: new Date(Date.now() - 3_600_000), isPrimary: false }), newer = await item(owner, "Example Movie", { groupKey: key });
  await refreshPrimaries(db, owner.id, [key]);
  const libraryId = await library(owner, [viewer]);
  await request(app).put(url(libraryId, older.id)).set(auth(viewer.token));
  expect(await db.libraryFavorite.count()).toBe(1);
  expect((await mine(viewer)).body.items.map((row: { item: { id: string } }) => row.item.id)).toEqual([newer.id]);
  expect((await request(app).get(`/api/shared-libraries/${libraryId}/items/${newer.id}`).set(auth(viewer.token))).body.item.favorite).toBe(true);
  await request(app).delete(url(libraryId, newer.id)).set(auth(viewer.token));
  expect(await db.libraryFavorite.count()).toBe(0);
});

it("only lists titles in libraries the viewer can see, keeps the rest stored, and brings them back with access", async () => {
  const owner = await user("admin"), viewer = await user(), stranger = await user(), film = await item(owner, "Example Movie");
  const libraryId = await library(owner, [viewer]);
  expect((await request(app).put(url(libraryId, film.id)).set(auth(stranger.token))).status).toBe(404); // not shared with this person
  await request(app).put(url(libraryId, film.id)).set(auth(viewer.token));
  expect((await request(app).delete(`/api/admin/shared-libraries/${libraryId}/users/${viewer.id}`).set(auth(owner.token))).status).toBe(200);
  expect((await mine(viewer)).body.items).toEqual([]); expect(await db.libraryFavorite.count()).toBe(1); // hidden, not deleted
  await request(app).post(`/api/admin/shared-libraries/${libraryId}/users`).set(auth(owner.token)).send({ userId: viewer.id });
  expect((await mine(viewer)).body.items).toHaveLength(1);
  expect((await request(app).put(url(libraryId, "missing-item")).set(auth(viewer.token))).status).toBe(404);
});

it("respects a viewing limit: a title above it cannot be added and drops off the list when the limit tightens", async () => {
  const owner = await user("admin"), kid = await user("user", 7), kids = await item(owner, "Kids Movie"), adult = await item(owner, "Grown-up Movie", { minAge: 17, ratingLabel: "R" });
  const libraryId = await library(owner, [kid]);
  expect((await request(app).put(url(libraryId, adult.id)).set(auth(kid.token))).status).toBe(404);
  expect((await request(app).put(url(libraryId, kids.id)).set(auth(kid.token))).status).toBe(200);
  await db.libraryFavorite.create({ data: { userId: kid.id, ownerId: owner.id, groupKey: adult.groupKey! } }); // listed before the limit existed
  expect((await mine(kid)).body.items.map((row: { item: { name: string } }) => row.item.name)).toEqual(["Kids Movie"]);
});

it("caps the list and says so", async () => {
  const owner = await user("admin"), viewer = await user(), film = await item(owner, "Example Movie"), libraryId = await library(owner, [viewer]);
  await db.libraryFavorite.createMany({ data: Array.from({ length: MAX_FAVORITES }, (_, index) => ({ userId: viewer.id, ownerId: owner.id, groupKey: `filler:${index}` })) });
  const full = await request(app).put(url(libraryId, film.id)).set(auth(viewer.token));
  expect(full.status).toBe(409); expect(full.body.error).toMatch(/full/i);
  await db.libraryFavorite.deleteMany({ where: { userId: viewer.id, groupKey: "filler:0" } });
  expect((await request(app).put(url(libraryId, film.id)).set(auth(viewer.token))).status).toBe(200);
});

it("removes a person's list with their account", async () => {
  const owner = await user("admin"), viewer = await user(), film = await item(owner, "Example Movie"), libraryId = await library(owner, [viewer]);
  await request(app).put(url(libraryId, film.id)).set(auth(viewer.token));
  await db.user.delete({ where: { id: viewer.id } });
  expect(await db.libraryFavorite.count()).toBe(0);
});
