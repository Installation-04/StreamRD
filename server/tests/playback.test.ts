import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminAndUser, app, auth, resetDb, TestUser } from "./helpers";

describe("catalog & playback integration", () => {
  let admin: TestUser;
  let user: TestUser;
  let titleId: string;

  beforeAll(async () => {
    await resetDb();
    ({ admin, user } = await adminAndUser());
    const created = await request(app)
      .post("/api/admin/catalog/create")
      .set(auth(admin.token))
      .send({
        name: "Test Movie",
        description: "An integration-test movie",
        type: "movie",
        genres: ["Drama"],
        year: 2024,
        sources: [
          { kind: "link", url: "https://host.example/movie", quality: "1080p" },
        ],
      });
    expect(created.status).toBe(201);
    titleId = created.body.title.id;
    await request(app)
      .put("/api/account/debrid")
      .set(auth(user.token))
      .send({
        primaryProvider: "realdebrid",
        realDebridToken: "rd-token",
        allDebridApiKey: "ad-key",
      });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("catalog rows require auth by default and include the title", async () => {
    expect((await request(app).get("/api/catalog/rows")).status).toBe(401);
    const res = await request(app).get("/api/catalog/rows").set(auth(user.token));
    expect(res.status).toBe(200);
    const all = res.body.rows.flatMap((r: { titles: Array<{ id: string }> }) => r.titles);
    expect(all.some((t: { id: string }) => t.id === titleId)).toBe(true);
    // Sources (raw debrid links) must not leak to regular users.
    expect(JSON.stringify(res.body)).not.toContain("host.example");
  });

  it("search and title detail work", async () => {
    const search = await request(app)
      .get("/api/catalog/search?q=test")
      .set(auth(user.token));
    expect(search.status).toBe(200);
    expect(search.body.results.length).toBeGreaterThan(0);
    const detail = await request(app)
      .get(`/api/catalog/title/${titleId}`)
      .set(auth(user.token));
    expect(detail.status).toBe(200);
    expect(detail.body.title.name).toBe("Test Movie");
  });

  it("resolves playback through the primary provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            download: "https://rd.example/stream.mp4",
            filename: "stream.mp4",
            filesize: 123,
            mimeType: "video/mp4",
          }),
          { status: 200 }
        )
      )
    );
    const res = await request(app)
      .post("/api/play")
      .set(auth(user.token))
      .send({ titleId });
    expect(res.status).toBe(200);
    expect(res.body.stream).toMatchObject({
      url: "https://rd.example/stream.mp4",
      provider: "realdebrid",
      quality: "1080p",
    });
  });

  it("falls back to the next provider when the primary fails", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("real-debrid")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "hoster_unavailable" }), { status: 503 })
        );
      }
      // AllDebrid /link/unlock success envelope
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "success",
            data: {
              link: "https://ad.example/stream.mp4",
              filename: "stream.mp4",
              filesize: 456,
            },
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app)
      .post("/api/play")
      .set(auth(user.token))
      .send({ titleId });
    expect(res.status).toBe(200);
    expect(res.body.stream.provider).toBe("alldebrid");
    expect(res.body.stream.url).toBe("https://ad.example/stream.mp4");
  });

  it("continue-watching lists successfully played titles once each, most recent first", async () => {
    const res = await request(app)
      .get("/api/account/continue-watching")
      .set(auth(user.token));
    expect(res.status).toBe(200);
    // Two successful plays happened above (primary, then fallback) — deduped to one entry.
    expect(res.body.titles).toHaveLength(1);
    expect(res.body.titles[0].id).toBe(titleId);
    // A user with no playback history gets an empty list, not an error.
    const other = await request(app).post("/api/auth/signup").send({
      email: "no-history@test.local",
      password: "password123",
      displayName: "No History",
    });
    const empty = await request(app)
      .get("/api/account/continue-watching")
      .set(auth(other.body.token));
    expect(empty.body.titles).toEqual([]);
  });

  it("fails with 502 and logs when every provider fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 500 }))
    );
    const res = await request(app)
      .post("/api/play")
      .set(auth(user.token))
      .send({ titleId });
    expect(res.status).toBe(502);
    const health = await request(app).get("/api/admin/health").set(auth(admin.token));
    expect(health.body.playback.recentFailures).toBeGreaterThan(0);
  });

  it("admin can update and delete catalog entries", async () => {
    const upd = await request(app)
      .patch(`/api/admin/catalog/${titleId}/update`)
      .set(auth(admin.token))
      .send({ description: "Updated description" });
    expect(upd.status).toBe(200);
    expect(upd.body.title.description).toBe("Updated description");
    const created = await request(app)
      .post("/api/admin/catalog/create")
      .set(auth(admin.token))
      .send({ name: "Delete me" });
    const del = await request(app)
      .delete(`/api/admin/catalog/${created.body.title.id}/delete`)
      .set(auth(admin.token));
    expect(del.status).toBe(200);
  });

  it("config export includes settings and catalog; import round-trips", async () => {
    const exported = await request(app)
      .get("/api/admin/export/config")
      .set(auth(admin.token));
    expect(exported.status).toBe(200);
    expect(exported.body.server).toBeTruthy();
    expect(exported.body.catalog.length).toBeGreaterThan(0);
    const imported = await request(app)
      .post("/api/admin/import/config")
      .set(auth(admin.token))
      .send(exported.body);
    expect(imported.status).toBe(200);
    expect(imported.body.ok).toBe(true);
  });
});
