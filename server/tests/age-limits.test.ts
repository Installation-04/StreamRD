import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { queueAccountScans, runAccountLibraryJob, setAccountImportHook } from "../src/account-library";
import { scanAccountPage } from "../src/providers/account-library";
import { ageForRating, backfillRatings } from "../src/ratings";

vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const scan = vi.mocked(scanAccountPage);
let serial = 0;
async function user(role: "admin" | "user" = "user", maxAge: number | null = null) {
  const row = await db.user.create({ data: { email: `limits-${serial++}@example.invalid`, displayName: role === "admin" ? "Owner" : "Member", hashedPassword: "fixture-no-password-auth", role, maxAge } });
  return { ...row, token: signSession({ sub: row.id, email: row.email, role, version: row.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
const names = ["Kid.Cartoon.2019.mkv", "Family.Film.2018.mkv", "Teen.Drama.2020.mkv", "Adult.Thriller.2021.mkv", "Mystery.Unrated.2022.mkv"];
async function imports(owner: User) {
  await db.debridConfig.create({ data: { userId: owner.id, realDebridToken: "server-only-private-key" } });
  scan.mockResolvedValue({ items: names.map((name, index) => ({ providerRef: `ref-${index}`, name, phase: "finished" as const, progress: 100 })), nextCursor: null });
  await queueAccountScans(owner.id); await runAccountLibraryJob();
  return Object.fromEntries((await db.accountMedia.findMany({ where: { userId: owner.id } })).map(item => [item.name.split(" ")[0].toLowerCase().replace(/\..*/, ""), item])) as Record<string, { id: string; name: string }>;
}
const rate = (owner: User, itemId: string, rating: string | null) => request(app).put(`/api/admin/shared-libraries/items/${itemId}/rating`).set(auth(owner.token)).send({ rating });
async function matched(item: { id: string; name: string }, owner: User, contentRating: string | null) {
  await db.metadataRecord.create({ data: { targetType: "account", targetId: item.id, ownerId: owner.id, name: item.name, mediaType: "movie", status: "matched",
    data: JSON.stringify({ provider: "tmdb", id: "1", name: item.name, type: "movie", year: 2020, genres: [], cast: [], fetchedAt: new Date().toISOString(), contentRating }) } });
}
const ids = (response: { body: { items: Array<{ id: string }> } }) => response.body.items.map(item => item.id).sort();
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); setAccountImportHook(null); });
afterEach(() => vi.restoreAllMocks());

it("turns rating labels into minimum ages and refuses to guess", () => {
  expect(["G", "TV-Y", "TV-G", "TV-Y7", "TV-Y7-FV", "PG", "TV-PG", "PG-13", "TV-14", "R", "TV-MA", "NC-17"].map(ageForRating)).toEqual([0, 0, 0, 7, 7, 8, 8, 13, 14, 17, 17, 18]);
  expect([" pg-13 ", "US: R", "12", "12A", "16+", "FSK 16", "u"].map(ageForRating)).toEqual([13, 17, 12, 12, 16, 16, 0]);
  expect(["", "Not Rated", "NR", "Unrated", "banana", "99", null, undefined].map(value => ageForRating(value as string))).toEqual([null, null, null, null, null, null, null, null]);
});
it("lets only administrators set a viewing limit, from the offered levels", async () => {
  const owner = await user("admin"), member = await user();
  expect((await request(app).patch(`/api/admin/users/${member.id}`).set(auth(member.token)).send({ maxAge: 7 })).status).toBe(403);
  for (const bad of [5, 99, "kids", 7.5]) expect((await request(app).patch(`/api/admin/users/${member.id}`).set(auth(owner.token)).send({ maxAge: bad })).status).toBe(400);
  const set = await request(app).patch(`/api/admin/users/${member.id}`).set(auth(owner.token)).send({ maxAge: 8 });
  expect(set.status).toBe(200); expect(set.body.user.maxAge).toBe(8);
  expect((await request(app).patch(`/api/admin/users/${member.id}`).set(auth(owner.token)).send({ maxAge: null })).body.user.maxAge).toBeNull();
});
it("shows a limited account only titles rated at or below its limit, and never unrated ones", async () => {
  const owner = await user("admin"), items = await imports(owner), kid = await user("user", 8), teen = await user("user", 14), grown = await user();
  const library = (await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Everything", mediaType: "all", everyone: true })).body.library.id as string;
  await matched(items.kid, owner, "TV-Y7"); await matched(items.family, owner, "PG"); await matched(items.teen, owner, "PG-13"); await matched(items.adult, owner, "R");
  expect(await backfillRatings()).toBe(4);
  const list = (viewer: User) => request(app).get(`/api/shared-libraries/${library}/items`).set(auth(viewer.token));
  expect(ids(await list(kid))).toEqual([items.family.id, items.kid.id].sort());
  expect(ids(await list(teen))).toEqual([items.family.id, items.kid.id, items.teen.id].sort());
  expect(ids(await list(grown))).toEqual(Object.values(items).map(item => item.id).sort());          // no limit: everything, unrated included
  expect(ids(await list(owner))).toEqual(Object.values(items).map(item => item.id).sort());          // administrators are never limited
  expect((await request(app).get("/api/shared-libraries").set(auth(kid.token))).body.libraries[0].itemCount).toBe(2);
  expect((await request(app).get("/api/shared-libraries").set(auth(grown.token))).body.libraries[0].itemCount).toBe(5);
  // Hidden titles do not exist for the limited account: no detail and no playback.
  for (const hidden of [items.adult, items.teen, items.mystery]) {
    expect((await request(app).get(`/api/shared-libraries/${library}/items/${hidden.id}`).set(auth(kid.token))).status).toBe(404);
    expect((await request(app).post(`/api/shared-libraries/${library}/items/${hidden.id}/play`).set(auth(kid.token)).send({})).status).toBe(404);
  }
  expect((await request(app).get(`/api/shared-libraries/${library}/items/${items.kid.id}`).set(auth(kid.token))).status).toBe(200);
  expect((await request(app).get(`/api/shared-libraries/${library}/items?q=Adult`).set(auth(kid.token))).body.items).toEqual([]);
  // The limit is read on every request, so changing it applies at once, without signing in again.
  await db.user.update({ where: { id: kid.id }, data: { maxAge: 17 } });
  expect(ids(await list(kid))).toEqual([items.family.id, items.kid.id, items.teen.id, items.adult.id].sort());
});
it("lets an administrator rate a title by hand, which wins over metadata and can be cleared", async () => {
  const owner = await user("admin"), items = await imports(owner), kid = await user("user", 7);
  const library = (await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "All", mediaType: "all", everyone: true })).body.library.id as string;
  await matched(items.adult, owner, "R");
  const seen = async () => ids(await request(app).get(`/api/shared-libraries/${library}/items`).set(auth(kid.token)));
  expect(await seen()).toEqual([]);
  expect((await rate(owner, items.kid.id, "G")).body).toEqual({ ratingLabel: "G", minAge: 0, ratingManual: true });
  expect(await seen()).toEqual([items.kid.id]);
  expect((await rate(owner, items.adult.id, "TV-Y7")).status).toBe(200);        // an administrator's word beats the stored R
  expect(await seen()).toEqual([items.adult.id, items.kid.id].sort());
  expect((await rate(owner, items.adult.id, null)).body).toEqual({ ratingLabel: "R", minAge: 17, ratingManual: false });   // cleared: back to metadata
  expect(await seen()).toEqual([items.kid.id]);
  expect((await rate(owner, items.kid.id, "banana")).status).toBe(400);
  expect((await request(app).put(`/api/admin/shared-libraries/items/${items.kid.id}/rating`).set(auth(kid.token)).send({ rating: "G" })).status).toBe(403);
  expect((await rate(await user("admin"), items.kid.id, "G")).status).toBe(404);   // only the importing administrator's own titles
  const detail = await request(app).get(`/api/shared-libraries/${library}/items/${items.kid.id}`).set(auth(owner.token));
  expect(detail.body.item).toMatchObject({ ratingLabel: "G", ratingManual: true });
});
it("closes discovery, requests and personal libraries to limited accounts only", async () => {
  const kid = await user("user", 7), grown = await user();
  for (const path of ["/api/discovery/search?q=Sintel&type=movie", "/api/requests", "/api/account/library", "/api/debrid/status"]) {
    expect((await request(app).get(path).set(auth(kid.token))).status, path).toBe(403);
    expect((await request(app).get(path).set(auth(grown.token))).status, path).not.toBe(403);
  }
  expect((await request(app).get("/api/shared-libraries").set(auth(kid.token))).status).toBe(200);
});
