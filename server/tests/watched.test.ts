import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { accountProviderContext } from "../src/account-library";
import { refreshPrimaries } from "../src/versions";

let serial = 0;
async function user(role: "admin" | "user" = "user", maxAge: number | null = null) {
  const created = await db.user.create({ data: { email: `watched-${serial++}@example.invalid`, displayName: role === "admin" ? "Server owner" : "Family member", hashedPassword: "fixture-no-password-auth", role, maxAge } });
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
const url = (libraryId: string, itemId: string) => `/api/shared-libraries/${libraryId}/items/${itemId}/watched`;
const page = (libraryId: string, viewer: User, query = "") => request(app).get(`/api/shared-libraries/${libraryId}/items${query}`).set(auth(viewer.token));
const names = (res: { body: { items: Array<{ name: string }> } }) => res.body.items.map(row => row.name).sort();

beforeEach(async () => { await resetDb(); });

it("marks a title watched for the viewer only, shows it everywhere, and unmarks it again", async () => {
  const owner = await user("admin"), alice = await user(), bob = await user(), film = await item(owner, "Example Movie"), other = await item(owner, "Other Movie");
  const libraryId = await library(owner, [alice, bob]);
  const marked = await request(app).put(url(libraryId, film.id)).set(auth(alice.token));
  expect(marked.status).toBe(200); expect(marked.body).toEqual({ watched: true });
  expect((await request(app).put(url(libraryId, film.id)).set(auth(alice.token))).status).toBe(200); // twice is fine
  const rows = (await page(libraryId, alice)).body.items as Array<{ id: string; watched: boolean }>;
  expect(rows.find(row => row.id === film.id)!.watched).toBe(true); expect(rows.find(row => row.id === other.id)!.watched).toBe(false);
  expect((await request(app).get(`/api/shared-libraries/${libraryId}/items/${film.id}`).set(auth(alice.token))).body.item.watched).toBe(true);
  expect((await request(app).get(`/api/shared-libraries/${libraryId}/items/${film.id}`).set(auth(bob.token))).body.item.watched).toBe(false);
  expect((await request(app).delete(url(libraryId, film.id)).set(auth(alice.token))).body).toEqual({ watched: false });
  expect((await request(app).get(`/api/shared-libraries/${libraryId}/items/${film.id}`).set(auth(alice.token))).body.item.watched).toBe(false);
});

it("treats finished playback as watched, and the Unwatched view leaves those titles out", async () => {
  const owner = await user("admin"), viewer = await user(), seen = await item(owner, "Seen It"), half = await item(owner, "Half Way"), fresh = await item(owner, "Fresh");
  const libraryId = await library(owner, [viewer]);
  await db.sharedLibraryProgress.create({ data: { userId: viewer.id, itemId: seen.id, mediaKey: "k1", positionSeconds: 98, durationSeconds: 100, completed: true, activeSessionId: "s1" } });
  await db.sharedLibraryProgress.create({ data: { userId: viewer.id, itemId: half.id, mediaKey: "k1", positionSeconds: 40, durationSeconds: 100, activeSessionId: "s2" } });
  expect(names(await page(libraryId, viewer))).toEqual(["Fresh", "Half Way", "Seen It"]);
  expect(names(await page(libraryId, viewer, "?unwatched=1"))).toEqual(["Fresh", "Half Way"]);
  expect((await page(libraryId, viewer, "?unwatched=1")).body.total).toBe(2);
  expect(fresh.id).toBeTruthy();
});

it("marking watched clears a resume point, and unmarking restarts the title", async () => {
  const owner = await user("admin"), viewer = await user(), film = await item(owner, "Half Way");
  const libraryId = await library(owner, [viewer]);
  await db.sharedLibraryProgress.create({ data: { userId: viewer.id, itemId: film.id, mediaKey: "k1", positionSeconds: 40, durationSeconds: 100, activeSessionId: "s1" } });
  const resume = () => request(app).get("/api/shared-libraries/continue").set(auth(viewer.token));
  expect((await resume()).body.items).toHaveLength(1);
  await request(app).put(url(libraryId, film.id)).set(auth(viewer.token));
  expect((await resume()).body.items).toEqual([]);
  await request(app).delete(url(libraryId, film.id)).set(auth(viewer.token));
  const row = await db.sharedLibraryProgress.findFirst({ where: { userId: viewer.id, itemId: film.id, mediaKey: "k1" } });
  expect(row).toMatchObject({ completed: false, positionSeconds: 0 });
  expect(await db.sharedLibraryProgress.count({ where: { userId: viewer.id, mediaKey: "manual" } })).toBe(0);
});

it("counts any version of a title, and only for a viewer who can see it", async () => {
  const owner = await user("admin"), viewer = await user(), outsider = await user();
  const a = await item(owner, "Example Movie", { groupKey: "movie:example", isPrimary: true }), b = await item(owner, "Example Movie", { groupKey: "movie:example", isPrimary: false });
  const libraryId = await library(owner, [viewer]);
  await request(app).put(url(libraryId, b.id)).set(auth(viewer.token));
  expect((await page(libraryId, viewer)).body.items.find((row: { id: string }) => row.id === a.id).watched).toBe(true);
  expect((await request(app).put(url(libraryId, a.id)).set(auth(outsider.token))).status).toBeGreaterThanOrEqual(403);
  expect((await request(app).put(url(libraryId, a.id))).status).toBe(401);
});
