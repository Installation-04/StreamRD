import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { app, signup, auth, resetDb, TestUser } from "./helpers";
import { db } from "../src/db";
import { queueTarget, recordFor, runMetadataJob } from "../src/metadata/automation";
import { saveMetadataSettings } from "../src/metadata/settings";

let admin: TestUser, fetch: ReturnType<typeof vi.spyOn>;
const movie = { id: 123, title: "Sintel", release_date: "2010-09-30", overview: "Provider overview", poster_path: "/fixture.jpg", backdrop_path: "/backdrop.jpg", adult: false,
  genres: [{ name: "Fantasy" }], runtime: 15, vote_average: 7.4, vote_count: 50, credits: { cast: [{ name: "Fixture Actor" }] }, external_ids: { imdb_id: "tt1727587" } };
const sources = [{ kind: "link", url: "https://example.invalid/original.mp4", quality: "1080p", label: "Original" }];
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
function upstream(detail = movie) { fetch.mockImplementation(async (input: unknown) => json(String(input).includes("/search/") ? { results: [movie] } : detail)); }
async function create(extra: Record<string, unknown> = {}) {
  const response = await request(app).post("/api/admin/catalog/create").set(auth(admin.token)).send({ name: "Sintel", year: 2010, sources, ...extra });
  expect(response.status, JSON.stringify(response.body)).toBe(201); return response.body;
}
beforeEach(async () => { await resetDb(); admin = await signup("admin"); await saveMetadataSettings({ tmdbApiKey: `catalog-fixture-${randomUUID()}` }); fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unplanned upstream request")); });
afterEach(() => { vi.restoreAllMocks(); });

it("creates without network delay, then automatically enriches public web details while preserving playback sources", async () => {
  await saveMetadataSettings({ automatic: true }); upstream(); const { title, metadataQueued } = await create();
  expect(metadataQueued).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect((await recordFor("catalog", title.id))?.status).toBe("queued");
  await runMetadataJob();
  const result = await request(app).get(`/api/catalog/title/${title.id}`).set(auth(admin.token));
  expect(result.body.title).toMatchObject({ name: "Sintel", description: "Provider overview", genres: ["Fantasy"], sourceCount: 1, metadataStatus: "matched", metadata: { cast: ["Fixture Actor"], runtimeMinutes: 15, imdbId: "tt1727587" } });
  expect(result.body.title.sources).toBeUndefined(); expect(JSON.stringify(result.body)).not.toContain("_applied");
  expect(JSON.parse((await db.title.findUniqueOrThrow({ where: { id: title.id } })).sources)).toEqual(sources);
});
it("persists a reviewed draft selection as a pinned job without another search and keeps reviewed fields", async () => {
  upstream(); const { title, metadataQueued } = await create({ description: "My reviewed overview", metadataMatch: { provider: "tmdb", id: "123", type: "movie" } });
  expect(metadataQueued).toBe(true); expect(fetch).not.toHaveBeenCalled(); await runMetadataJob();
  expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0][0])).toContain("/movie/123");
  expect(await db.title.findUniqueOrThrow({ where: { id: title.id } })).toMatchObject({ description: "My reviewed overview" });
  expect((await recordFor("catalog", title.id))?.status).toBe("matched");
});
it("keeps preexisting custom fields even when their initial value equals the provider and refreshes fields actually supplied by it", async () => {
  upstream(); await saveMetadataSettings({ automatic: true }); const { title } = await create({ description: "Provider overview" }); await runMetadataJob();
  upstream({ ...movie, overview: "Changed upstream overview", poster_path: "/new.jpg" });
  await queueTarget({ targetType: "catalog", targetId: title.id, name: title.name, mediaType: "movie", year: 2010 }, true, true); await runMetadataJob();
  const updated = await db.title.findUniqueOrThrow({ where: { id: title.id } });
  expect(updated.description).toBe("Provider overview"); expect(updated.posterUrl).toBe("https://image.tmdb.org/t/p/w500/new.jpg");
});
it("records manual clears as field locks even before the first metadata match", async () => {
  upstream(); const { title } = await create({ description: "Administrator overview" });
  const edited = await request(app).patch(`/api/admin/catalog/${title.id}/update`).set(auth(admin.token)).send({ description: "" }); expect(edited.status).toBe(200);
  expect(JSON.parse((await recordFor("catalog", title.id))!.lockedFields)).toContain("description");
  await saveMetadataSettings({ automatic: true }); await runMetadataJob();
  const updated = await db.title.findUniqueOrThrow({ where: { id: title.id } }); expect(updated.description).toBe(""); expect(updated.posterUrl).toBeTruthy();
});
it("invalidates an in-flight job when an administrator edits the catalog and keeps the edit on retry", async () => {
  await saveMetadataSettings({ automatic: true }); const { title } = await create();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  fetch.mockImplementation(async (input: unknown) => { if (String(input).includes("/search/")) return json({ results: [movie] }); entered(); await gate; return json(movie); });
  const work = runMetadataJob(); await started;
  const edited = await request(app).patch(`/api/admin/catalog/${title.id}/update`).set(auth(admin.token)).send({ description: "Manual edit during lookup" }); expect(edited.status).toBe(200);
  release(); await work;
  expect((await recordFor("catalog", title.id))?.status).toBe("queued"); expect((await db.title.findUniqueOrThrow({ where: { id: title.id } })).description).toBe("Manual edit during lookup");
  await runMetadataJob(); expect((await recordFor("catalog", title.id))?.status).toBe("matched");
  expect((await db.title.findUniqueOrThrow({ where: { id: title.id } })).description).toBe("Manual edit during lookup");
});
it("moves a changed title identity to review and removes stale cast/IMDb identity without altering sources", async () => {
  upstream(); const { title } = await create();
  expect((await request(app).post(`/api/admin/metadata/records/catalog/${title.id}/match`).set(auth(admin.token)).send({ provider: "tmdb", id: "123", type: "movie" })).status).toBe(200);
  const edited = await request(app).patch(`/api/admin/catalog/${title.id}/update`).set(auth(admin.token)).send({ name: "A different film" }); expect(edited.status).toBe(200);
  const result = await request(app).get(`/api/catalog/title/${title.id}`).set(auth(admin.token)); expect(result.body.title.metadata).toBeNull(); expect(result.body.title.metadataStatus).toBe("review");
  expect(JSON.parse((await db.title.findUniqueOrThrow({ where: { id: title.id } })).sources)).toEqual(sources);
});
it("does not recreate metadata after a catalog entry is deleted during a lookup", async () => {
  await saveMetadataSettings({ automatic: true }); const { title } = await create();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  fetch.mockImplementation(async (input: unknown) => { if (String(input).includes("/search/")) return json({ results: [movie] }); entered(); await gate; return json(movie); });
  const work = runMetadataJob(); await started;
  expect((await request(app).delete(`/api/admin/catalog/${title.id}/delete`).set(auth(admin.token))).status).toBe(200);
  release(); await work; expect(await recordFor("catalog", title.id)).toBeNull(); expect(await db.title.count()).toBe(0);
});
it("rejects unconfigured or mismatched draft identities before creating a catalog item", async () => {
  await saveMetadataSettings({ clearTmdb: true });
  const rejected = await request(app).post("/api/admin/catalog/create").set(auth(admin.token)).send({ name: "Sintel", type: "movie", metadataMatch: { provider: "tmdb", id: "123", type: "movie" } }); expect(rejected.status).toBe(400); expect(await db.title.count()).toBe(0);
  const invalid = await request(app).post("/api/admin/catalog/create").set(auth(admin.token)).send({ name: "Sintel", metadataMatch: { provider: "tmdb", id: "../secret", type: "movie" } }); expect(invalid.status).toBe(400); expect(fetch).not.toHaveBeenCalled();
});
