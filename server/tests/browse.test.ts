import request from "supertest";
import { beforeAll, expect, it } from "vitest";
import { db } from "../src/db";
import { app, auth, resetDb, signup, TestUser } from "./helpers";
let user: TestUser;
const at = new Date("2026-01-01T00:00:00Z");
beforeAll(async () => {
  await resetDb(); user = await signup();
  await db.title.createMany({ data: Array.from({ length: 65 }, (_, index) => ({
    id: `title-${String(index).padStart(3, "0")}`, name: `Movie ${index}`,
    description: "Large private description".repeat(100), type: index % 2 ? "series" : "movie",
    createdAt: at, genres: JSON.stringify(["Drama", `Genre ${index % 9}`, "A \"quoted\" genre"]),
    sources: JSON.stringify([{ kind: "link", url: "https://private-source.example/file" }]),
  })) });
});
it("requires authentication and validates pagination input", async () => {
  expect((await request(app).get("/api/catalog/browse")).status).toBe(401);
  for (const query of ["limit=0", "limit=51", "limit=abc", "limit=1.5", "limit=2&limit=3"]) {
    expect((await request(app).get(`/api/catalog/browse?${query}`).set(auth(user.token))).status).toBe(400);
  }
  for (const query of ["row=unknown", "row=genre:", "row=movies&cursor=garbage"]) {
    expect((await request(app).get(`/api/catalog/browse/row?${query}`).set(auth(user.token))).status).toBe(400);
  }
});
it("bounds initial rows and returns only card fields", async () => {
  const res = await request(app).get("/api/catalog/browse?limit=4").set(auth(user.token));
  expect(res.status).toBe(200);
  expect(res.body.rows.length).toBeLessThanOrEqual(8);
  expect(res.body.nextGenre).toBeTypeOf("string");
  for (const row of res.body.rows) {
    expect(row.titles.length).toBeLessThanOrEqual(4);
    for (const card of row.titles) expect(Object.keys(card).sort()).toEqual(["id", "name", "posterUrl", "year"]);
  }
  expect(JSON.stringify(res.body)).not.toContain("private-source");
  expect(JSON.stringify(res.body)).not.toContain("Large private description");
});
it("paginates all titles with identical timestamps without gaps or duplicates", async () => {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const res: request.Response = await request(app).get(`/api/catalog/browse/row?row=recent&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).set(auth(user.token));
    expect(res.status).toBe(200);
    ids.push(...res.body.titles.map((t: { id: string }) => t.id));
    cursor = res.body.nextCursor;
  } while (cursor);
  expect(ids).toEqual(Array.from({ length: 65 }, (_, i) => `title-${String(64 - i).padStart(3, "0")}`));
});
it("keeps cursor ordering stable when its title is deleted and newer titles arrive", async () => {
  const first = await request(app).get("/api/catalog/browse/row?row=recent&limit=2").set(auth(user.token));
  const last = first.body.titles[1].id;
  await db.title.delete({ where: { id: last } });
  await db.title.create({ data: { id: "new-title", name: "New", createdAt: new Date("2026-02-01") } });
  try {
    const second = await request(app).get(`/api/catalog/browse/row?row=recent&limit=2&cursor=${first.body.nextCursor}`).set(auth(user.token));
    expect(second.status).toBe(200);
    expect(second.body.titles.map((t: { id: string }) => t.id)).toEqual(["title-062", "title-061"]);
  } finally {
    await db.title.delete({ where: { id: "new-title" } });
    await db.title.create({ data: { id: last, name: "Restored", type: "series", createdAt: at, genres: '["Drama"]' } });
  }
});
it("rejects a cursor reused for a different row", async () => {
  const first = await request(app).get("/api/catalog/browse/row?row=recent&limit=2").set(auth(user.token));
  const res = await request(app).get(`/api/catalog/browse/row?row=movies&cursor=${first.body.nextCursor}`).set(auth(user.token));
  expect(res.status).toBe(400);
});
it("returns every genre through bounded row pages", async () => {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const res: request.Response = await request(app).get(`/api/catalog/browse?limit=1${after ? `&afterGenre=${encodeURIComponent(after)}` : ""}`).set(auth(user.token));
    expect(res.status).toBe(200);
    ids.push(...res.body.rows.filter((row: { id: string }) => row.id.startsWith("genre:")).map((row: { id: string }) => row.id));
    after = res.body.nextGenre;
  } while (after);
  expect(new Set(ids).size).toBe(11);
  expect(ids).toHaveLength(11);
});
it("filters exact genres and handles quotes without SQL interpolation", async () => {
  for (const genre of ['A "quoted" genre', "Drama"]) {
    const res: request.Response = await request(app).get(`/api/catalog/browse/row?row=${encodeURIComponent(`genre:${genre}`)}&limit=2`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.titles).toHaveLength(2);
  }
  const res = await request(app).get(`/api/catalog/browse/row?row=${encodeURIComponent("genre:Drama' OR 1=1 --")}`).set(auth(user.token));
  expect(res.status).toBe(200);
  expect(res.body.titles).toEqual([]);
});
it("ignores invalid/non-array genre JSON", async () => {
  await db.title.createMany({ data: ["bad json", '{"a":"Not a genre"}', '"Not a genre"'].map((genres, i) => ({ id: `bad-${i}`, name: "Bad genres", genres })) });
  try {
    const res: request.Response = await request(app).get("/api/catalog/browse").set(auth(user.token));
    expect(res.status).toBe(200);
    const row = await request(app).get(`/api/catalog/browse/row?row=${encodeURIComponent("genre:Not a genre")}`).set(auth(user.token));
    expect(row.body.titles).toEqual([]);
  } finally { await db.title.deleteMany({ where: { id: { startsWith: "bad-" } } }); }
});
it("preserves the legacy full-title endpoint", async () => {
  const res = await request(app).get("/api/catalog/rows").set(auth(user.token));
  expect(res.status).toBe(200);
  expect(res.body.rows.find((row: { id: string }) => row.id === "movies").titles.length).toBeGreaterThan(20);
  expect(res.body.rows[0].titles[0]).toHaveProperty("description");
});
it("uses the composite indexes for recent and type row ordering", async () => {
  const recent = await db.$queryRaw<Array<{ detail: string }>>`EXPLAIN QUERY PLAN SELECT id FROM Title ORDER BY createdAt DESC, id DESC LIMIT 21`;
  const movies = await db.$queryRaw<Array<{ detail: string }>>`EXPLAIN QUERY PLAN SELECT id FROM Title WHERE type = 'movie' ORDER BY createdAt DESC, id DESC LIMIT 21`;
  expect(recent.some(row => row.detail.includes("Title_createdAt_id_idx"))).toBe(true);
  expect(movies.some(row => row.detail.includes("Title_type_createdAt_id_idx"))).toBe(true);
});
