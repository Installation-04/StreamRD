import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("admin can export and import config", async () => {
    const exported = await request(app).get("/api/admin/export/config").set(auth(admin.token));
    expect(exported.status).toBe(200);
    expect(exported.body.indexers.length).toBeGreaterThan(0);
    const imported = await request(app).post("/api/admin/import/config").set(auth(admin.token)).send(exported.body);
    expect(imported.status).toBe(200);
    expect(imported.body.ok).toBe(true);
  });
});
