import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { cachedIndexerSearch, clearIndexerSearchCache } from "../src/indexers/searchCache";
import { app, auth, resetDb } from "./helpers";
let token: string, indexerId: string;
const xml = (name: string) => `<rss><channel><item><title>${name}</title><link>magnet:?xt=urn:btih:test</link></item></channel></rss>`;
beforeEach(async () => {
  await resetDb(); clearIndexerSearchCache();
  const user = await db.user.create({ data: { email: "search@test.local", displayName: "Search", role: "admin", hashedPassword: "not-for-login" } });
  token = signSession({ sub: user.id, email: user.email, role: "admin" });
  indexerId = (await db.indexerConfig.create({ data: { name: "Indexer", baseUrl: "http://indexer.test/api", apiKey: "fixture-key" } })).id;
});
afterEach(() => vi.unstubAllGlobals());
it("limits concurrent indexer work across multiple searches while keeping partial results", async () => {
  let active = 0, max = 0;
  const releases: Array<() => void> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    active++; max = Math.max(max, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--;
    if (url.includes("bad")) throw new Error("offline");
    return new Response(xml("Result"));
  }));
  const indexers = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, name: `${i}`, baseUrl: `http://${i === 6 ? "bad" : "indexer"}.test/${i}`, apiKey: "fixture" }));
  const work = Promise.allSettled(indexers.map(i => cachedIndexerSearch(i, "query", { timeoutMs: 15000, limit: 20 })));
  while (releases.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
  expect(max).toBe(4);
  for (let n = 0; n < 8; n++) { while (!releases.length) await new Promise(resolve => setTimeout(resolve, 1)); releases.shift()!(); await new Promise(resolve => setTimeout(resolve, 1)); }
  const results = await work;
  expect(max).toBe(4); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(7);
});
it("coalesces requests but separates exact queries and configuration snapshots", async () => {
  const fetchMock = vi.fn(async () => new Response(xml("Result"))); vi.stubGlobal("fetch", fetchMock);
  const indexer = await db.indexerConfig.findUniqueOrThrow({ where: { id: indexerId } });
  await Promise.all([cachedIndexerSearch(indexer, "Query", { timeoutMs: 1000, limit: 20 }), cachedIndexerSearch(indexer, "Query", { timeoutMs: 1000, limit: 20 })]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await cachedIndexerSearch(indexer, "query", { timeoutMs: 1000, limit: 20 });
  await cachedIndexerSearch({ ...indexer, apiKey: "new-fixture" }, "Query", { timeoutMs: 1000, limit: 20 });
  await cachedIndexerSearch(indexer, "Query", { timeoutMs: 1000, limit: 10 });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
it("invalidates caches after admin edits, server settings, and imports", async () => {
  const fetchMock = vi.fn(async () => new Response(xml("Result"))); vi.stubGlobal("fetch", fetchMock);
  const search = () => request(app).get("/api/search?q=test").set(auth(token));
  await search(); await search(); expect(fetchMock).toHaveBeenCalledTimes(1);
  await request(app).patch(`/api/admin/indexers/${indexerId}`).set(auth(token)).send({ baseUrl: "http://changed.test/api" });
  await search(); expect(fetchMock).toHaveBeenCalledTimes(2);
  await request(app).put("/api/admin/server").set(auth(token)).send({ maxResultsPerIndexer: 10 });
  await search(); expect(fetchMock).toHaveBeenCalledTimes(3);
  await request(app).post("/api/admin/import/config").set(auth(token)).send({ version: 1, indexers: [{ id: indexerId, name: "Imported", baseUrl: "http://imported.test/api", apiKey: "fixture" }] });
  const result = await search(); expect(fetchMock).toHaveBeenCalledTimes(4); expect(result.body.results[0].indexerName).toBe("Imported");
});
it("preserves successful indexer results when another fails and validates query input", async () => {
  await db.indexerConfig.create({ data: { name: "Bad", baseUrl: "http://bad.test/api", apiKey: "fixture" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("bad.test") ? new Response("offline", { status: 503 }) : new Response(xml("Good result"))));
  const result = await request(app).get("/api/search?q=test").set(auth(token));
  expect(result.body.results).toHaveLength(1); expect(result.body.errors).toHaveLength(1);
  for (const query of ["q=test&minSeeders=nope", "q=test&sort=unknown", "q=test&maxSizeGb=-1"]) expect((await request(app).get(`/api/search?${query}`).set(auth(token))).status).toBe(400);
});
it("clears cached results when indexers are added, deleted or re-enabled", async () => {
  const fetchMock = vi.fn(async () => new Response(xml("Result"))); vi.stubGlobal("fetch", fetchMock);
  const search = () => request(app).get("/api/search?q=changes").set(auth(token));
  await search(); expect(fetchMock).toHaveBeenCalledTimes(1);
  const created = await request(app).post("/api/admin/indexers").set(auth(token)).send({ name: "Second", baseUrl: "http://second.test/api", apiKey: "fixture" });
  expect(created.status).toBe(201); await search(); expect(fetchMock).toHaveBeenCalledTimes(3);
  await request(app).delete(`/api/admin/indexers/${created.body.indexer.id}`).set(auth(token)); await search(); expect(fetchMock).toHaveBeenCalledTimes(4);
  await request(app).patch(`/api/admin/indexers/${indexerId}`).set(auth(token)).send({ enabled: false }); await search(); expect(fetchMock).toHaveBeenCalledTimes(4);
  await request(app).patch(`/api/admin/indexers/${indexerId}`).set(auth(token)).send({ enabled: true }); await search(); expect(fetchMock).toHaveBeenCalledTimes(5);
});
