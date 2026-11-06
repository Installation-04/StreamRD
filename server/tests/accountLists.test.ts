import request from "supertest";
import { beforeAll, expect, it } from "vitest";
import { signSession } from "../src/auth/jwt";
import { db } from "../src/db";
import { app, auth, resetDb, TestUser } from "./helpers";
let user: TestUser, other: TestUser;
let accountNumber = 0;
async function createAccount(): Promise<TestUser> {
  const user = await db.user.create({ data: { email: `list-fixture-${accountNumber++}@test.local`, displayName: "List fixture", hashedPassword: "fixture-not-used-for-login" } });
  return { id: user.id, email: user.email, token: signSession({ sub: user.id, email: user.email, role: "user" }) };
}
const at = new Date("2026-01-01T00:00:00Z");
const titleId = (i: number) => `list-title-${String(i).padStart(3, "0")}`;
beforeAll(async () => {
  await resetDb(); user = await createAccount(); other = await createAccount();
  await db.title.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ id: titleId(i), name: `List title ${i}`, description: "private description".repeat(100), sources: '[{"kind":"link","url":"https://private-source.example"}]' })) });
  await db.favorite.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ id: `favorite-${String(i).padStart(3, "0")}`, userId: user.id, titleId: titleId(i), createdAt: at })) });
  await db.favorite.create({ data: { userId: other.id, titleId: titleId(1) } });
  await db.playbackLog.createMany({ data: [
    ...Array.from({ length: 220 }, () => ({ userId: user.id, titleId: titleId(0), success: true, providerUsed: "realdebrid", createdAt: new Date("2026-02-01") })),
    ...Array.from({ length: 54 }, (_, i) => ({ userId: user.id, titleId: titleId(i + 1), success: true, providerUsed: "realdebrid", createdAt: at })),
    { userId: user.id, titleId: titleId(1), success: false, providerUsed: "none", createdAt: new Date("2026-03-01") },
    { userId: other.id, titleId: titleId(1), success: true, providerUsed: "realdebrid", createdAt: new Date("2026-04-01") },
  ] });
});
it("requires auth for pages and membership lookup", async () => {
  for (const path of ["favorites/page", "continue-watching/page"]) expect((await request(app).get(`/api/account/${path}`)).status).toBe(401);
  expect((await request(app).post("/api/account/favorites/status").send({ titleIds: [] })).status).toBe(401);
});
it("returns compact bounded pages while preserving legacy favorites", async () => {
  const page = await request(app).get("/api/account/favorites/page").set(auth(user.token));
  expect(page.status).toBe(200); expect(page.body.titles).toHaveLength(20);
  expect(page.body.nextCursor).toBeTypeOf("string");
  expect(Object.keys(page.body.titles[0]).sort()).toEqual(["id", "name", "posterUrl", "year"]);
  expect(JSON.stringify(page.body)).not.toContain("private");
  const legacy = await request(app).get("/api/account/favorites").set(auth(user.token));
  expect(legacy.body.titles).toHaveLength(55);
  expect(legacy.body.titles[0]).toHaveProperty("description");
});
it("paginates favorites without gaps at equal timestamps", async () => {
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const res: request.Response = await request(app).get(`/api/account/favorites/page?limit=7${cursor ? `&cursor=${cursor}` : ""}`).set(auth(user.token));
    expect(res.status).toBe(200);
    ids.push(...res.body.titles.map((t: { id: string }) => t.id)); cursor = res.body.nextCursor;
  } while (cursor);
  expect(ids).toEqual(Array.from({ length: 55 }, (_, i) => titleId(54 - i)));
});
it("deduplicates all successful history before limiting, including the legacy endpoint", async () => {
  const page = await request(app).get("/api/account/continue-watching/page").set(auth(user.token));
  expect(page.status).toBe(200); expect(page.body.titles).toHaveLength(20);
  expect(page.body.titles[0].id).toBe(titleId(0));
  expect(page.body.titles[1].id).toBe(titleId(54));
  expect(Object.keys(page.body.titles[0]).sort()).toEqual(["id", "name", "posterUrl", "year"]);
  const legacy = await request(app).get("/api/account/continue-watching").set(auth(user.token));
  expect(legacy.body.titles).toHaveLength(20);
  expect(legacy.body.titles[0]).toHaveProperty("description");
});
it("paginates distinct history in stable latest-play order", async () => {
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const res: request.Response = await request(app).get(`/api/account/continue-watching/page?limit=8${cursor ? `&cursor=${cursor}` : ""}`).set(auth(user.token));
    expect(res.status).toBe(200);
    ids.push(...res.body.titles.map((t: { id: string }) => t.id)); cursor = res.body.nextCursor;
  } while (cursor);
  expect(ids).toEqual([titleId(0), ...Array.from({ length: 54 }, (_, i) => titleId(54 - i))]);
});
it("scopes pages and membership to the caller", async () => {
  const page = await request(app).get("/api/account/favorites/page").set(auth(other.token));
  expect(page.body.titles.map((t: { id: string }) => t.id)).toEqual([titleId(1)]);
  const history = await request(app).get("/api/account/continue-watching/page").set(auth(other.token));
  expect(history.body.titles.map((t: { id: string }) => t.id)).toEqual([titleId(1)]);
  const status = await request(app).post("/api/account/favorites/status").set(auth(other.token)).send({ titleIds: [titleId(0), titleId(1), titleId(1), "missing"] });
  expect(status.body.favoriteIds).toEqual([titleId(1)]);
});
it("validates page sizes and rejects malformed/cross-user/cross-list cursors", async () => {
  for (const path of ["favorites/page", "continue-watching/page"]) {
    for (const query of ["limit=0", "limit=51", "limit=2.5", "cursor=garbage", "cursor="]) expect((await request(app).get(`/api/account/${path}?${query}`).set(auth(user.token))).status).toBe(400);
  }
  const page = await request(app).get("/api/account/favorites/page").set(auth(user.token));
  expect((await request(app).get(`/api/account/favorites/page?cursor=${page.body.nextCursor}`).set(auth(other.token))).status).toBe(400);
  expect((await request(app).get(`/api/account/continue-watching/page?cursor=${page.body.nextCursor}`).set(auth(user.token))).status).toBe(400);
});
it("bounds membership lookup and handles empty input", async () => {
  for (const titleIds of [Array(201).fill("x"), [""]]) expect((await request(app).post("/api/account/favorites/status").set(auth(user.token)).send({ titleIds })).status).toBe(400);
  const empty = await request(app).post("/api/account/favorites/status").set(auth(user.token)).send({ titleIds: [] });
  expect(empty.body).toEqual({ favoriteIds: [] });
});
it("keeps cursors usable after removing the boundary favorite", async () => {
  const first = await request(app).get("/api/account/favorites/page?limit=2").set(auth(user.token));
  const removed = await db.favorite.findUniqueOrThrow({ where: { id: "favorite-053" } });
  await db.favorite.delete({ where: { id: removed.id } });
  try {
    const next = await request(app).get(`/api/account/favorites/page?limit=2&cursor=${first.body.nextCursor}`).set(auth(user.token));
    expect(next.body.titles.map((t: { id: string }) => t.id)).toEqual([titleId(52), titleId(51)]);
  } finally { await db.favorite.create({ data: removed }); }
});
it("returns empty pages for an account without favorites or history", async () => {
  const empty = await createAccount();
  for (const path of ["favorites/page", "continue-watching/page"]) expect((await request(app).get(`/api/account/${path}`).set(auth(empty.token))).body).toEqual({ titles: [], nextCursor: null });
});
it("uses covering/ordering indexes for account lists", async () => {
  const favorites = await db.$queryRaw<Array<{ detail: string }>>`EXPLAIN QUERY PLAN SELECT id FROM Favorite WHERE userId = ${user.id} ORDER BY createdAt DESC, id DESC LIMIT 21`;
  const history = await db.$queryRaw<Array<{ detail: string }>>`EXPLAIN QUERY PLAN SELECT titleId, MAX(createdAt) FROM PlaybackLog WHERE userId = ${user.id} AND success = 1 GROUP BY titleId ORDER BY MAX(createdAt) DESC, titleId DESC LIMIT 21`;
  expect(favorites.some(row => row.detail.includes("Favorite_userId_createdAt_id_idx"))).toBe(true);
  expect(history.some(row => row.detail.includes("PlaybackLog_userId_success_titleId_createdAt_idx"))).toBe(true);
});
