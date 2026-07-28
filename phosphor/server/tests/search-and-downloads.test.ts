import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSearchCache } from "../src/routes/search";
import { adminAndUser, app, auth, resetDb, TestUser } from "./helpers";

describe("search and downloads integration", () => {
  let admin: TestUser;
  let user: TestUser;
  let indexerId: string;

  beforeAll(async () => {
    await resetDb();
    ({ admin, user } = await adminAndUser());
    const created = await request(app)
      .post("/api/admin/indexers")
      .set(auth(admin.token))
      .send({ name: "Test Indexer", baseUrl: "http://jackett.local/api", apiKey: "jackett-key" });
    expect(created.status).toBe(201);
    indexerId = created.body.indexer.id;

    await request(app)
      .put("/api/account/debrid")
      .set(auth(user.token))
      .send({ primaryProvider: "realdebrid", realDebridToken: "rd-token" });
  });

  beforeEach(() => clearSearchCache());
  afterEach(() => vi.unstubAllGlobals());

  it("rejects search with no query and reports when no indexers are enabled", async () => {
    const empty = await request(app).get("/api/search?q=").set(auth(user.token));
    expect(empty.status).toBe(200);
    expect(empty.body.results).toEqual([]);

    await request(app).patch(`/api/admin/indexers/${indexerId}`).set(auth(admin.token)).send({ enabled: false });
    const disabled = await request(app).get("/api/search?q=test").set(auth(user.token));
    expect(disabled.body.errors[0]).toMatch(/no enabled indexers/i);
    await request(app).patch(`/api/admin/indexers/${indexerId}`).set(auth(admin.token)).send({ enabled: true });
  });

  it("searches an indexer, filters by seeders, and sorts by size", async () => {
    const xml = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
      <item><title>Low Seed</title><link>magnet:?xt=urn:btih:low</link>
        <torznab:attr name="size" value="1000"/><torznab:attr name="seeders" value="1"/></item>
      <item><title>High Seed Big</title><link>magnet:?xt=urn:btih:big</link>
        <torznab:attr name="size" value="5000"/><torznab:attr name="seeders" value="50"/></item>
    </channel></rss>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(xml, { status: 200 })));

    const res = await request(app).get("/api/search?q=test&minSeeders=10&sort=size").set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].title).toBe("High Seed Big");
  });

  it("caches raw indexer results so re-filtering the same query doesn't re-fetch", async () => {
    const xml = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
      <item><title>Cached Result</title><link>magnet:?xt=urn:btih:cached</link>
        <torznab:attr name="size" value="1000"/><torznab:attr name="seeders" value="5"/></item>
    </channel></rss>`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(xml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await request(app).get("/api/search?q=cachetest").set(auth(user.token));
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same query, different sort/filter — should reuse the cached raw results.
    const second = await request(app).get("/api/search?q=cachetest&sort=size").set(auth(user.token));
    expect(second.status).toBe(200);
    expect(second.body.results[0].title).toBe("Cached Result");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different query text must not hit the cache.
    const third = await request(app).get("/api/search?q=uncached").set(auth(user.token));
    expect(third.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adds a magnet download job and resolves it immediately when the provider returns a finished torrent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("addMagnet")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "t1" }), { status: 200 }));
        }
        if (url.includes("selectFiles")) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.includes("/torrents/info/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ id: "t1", filename: "movie.mkv", status: "downloaded", progress: 100, links: ["https://rd.example/hoster/1"] }),
              { status: 200 }
            )
          );
        }
        if (url.includes("/unrestrict/link")) {
          return Promise.resolve(
            new Response(JSON.stringify({ download: "https://rd.example/dl/movie.mkv", filename: "movie.mkv", filesize: 123 }), { status: 200 })
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      })
    );

    const res = await request(app)
      .post("/api/downloads")
      .set(auth(user.token))
      .send({ title: "Test Movie", sourceUrl: "magnet:?xt=urn:btih:abc", sizeBytes: 123, seeders: 10, indexerName: "Test Indexer" });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({ status: "finished", streamUrl: "https://rd.example/dl/movie.mkv" });

    const list = await request(app).get("/api/downloads").set(auth(user.token));
    expect(list.body.jobs).toHaveLength(1);
  });

  it("records a failed download job with a 502 when the provider errors out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "hoster_unavailable" }), { status: 503 })));
    const res = await request(app)
      .post("/api/downloads")
      .set(auth(user.token))
      .send({ title: "Broken", sourceUrl: "magnet:?xt=urn:btih:broken" });
    expect(res.status).toBe(502);
    expect(res.body.job.status).toBe("error");
  });

  it("fetches a single job by id and 404s for another user's job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "hoster_unavailable" }), { status: 503 }))
    );
    const created = await request(app)
      .post("/api/downloads")
      .set(auth(user.token))
      .send({ title: "Solo", sourceUrl: "magnet:?xt=urn:btih:solo" });
    const found = await request(app).get(`/api/downloads/${created.body.job.id}`).set(auth(user.token));
    expect(found.status).toBe(200);
    expect(found.body.job.title).toBe("Solo");
    const asAdmin = await request(app).get(`/api/downloads/${created.body.job.id}`).set(auth(admin.token));
    expect(asAdmin.status).toBe(404);
  });

  it("deletes a download job", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 500 })));
    const created = await request(app)
      .post("/api/downloads")
      .set(auth(user.token))
      .send({ title: "ToDelete", sourceUrl: "magnet:?xt=urn:btih:del" });
    const del = await request(app).delete(`/api/downloads/${created.body.job.id}`).set(auth(user.token));
    expect(del.status).toBe(200);
  });

  it("bulk-clears only finished/errored jobs, leaving active ones and other users untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "hoster_unavailable" }), { status: 503 }))
    );
    // Admin needs its own debrid key configured before it can submit a job at all.
    await request(app)
      .put("/api/account/debrid")
      .set(auth(admin.token))
      .send({ primaryProvider: "realdebrid", realDebridToken: "admin-rd-token" });

    // Two of the user's own jobs will end up "error" (provider fails immediately).
    await request(app).post("/api/downloads").set(auth(user.token)).send({ title: "Fail A", sourceUrl: "magnet:?xt=urn:btih:a" });
    await request(app).post("/api/downloads").set(auth(user.token)).send({ title: "Fail B", sourceUrl: "magnet:?xt=urn:btih:b" });
    // A job for a different account must survive the clear.
    await request(app).post("/api/downloads").set(auth(admin.token)).send({ title: "Admin Fail", sourceUrl: "magnet:?xt=urn:btih:c" });

    const before = await request(app).get("/api/downloads").set(auth(user.token));
    const failedCount = before.body.jobs.filter((j: { status: string }) => j.status === "error").length;
    expect(failedCount).toBeGreaterThanOrEqual(2);

    const cleared = await request(app).delete("/api/downloads/clear-completed").set(auth(user.token));
    expect(cleared.status).toBe(200);
    expect(cleared.body.removed).toBeGreaterThanOrEqual(2);

    const after = await request(app).get("/api/downloads").set(auth(user.token));
    expect(after.body.jobs.some((j: { status: string }) => j.status === "error")).toBe(false);

    const adminJobs = await request(app).get("/api/downloads").set(auth(admin.token));
    expect(adminJobs.body.jobs.some((j: { title: string }) => j.title === "Admin Fail")).toBe(true);
  });

  it("admin can export and import config", async () => {
    const exported = await request(app).get("/api/admin/export/config").set(auth(admin.token));
    expect(exported.status).toBe(200);
    expect(exported.body.indexers.length).toBeGreaterThan(0);
    const imported = await request(app).post("/api/admin/import/config").set(auth(admin.token)).send(exported.body);
    expect(imported.status).toBe(200);
    expect(imported.body.ok).toBe(true);
  });
});
