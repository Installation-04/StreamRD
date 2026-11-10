import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, signup, auth, resetDb, TestUser } from "./helpers";
import { config } from "../src/config";
import { db } from "../src/db";
import { getMetadataSettings, saveMetadataSettings } from "../src/metadata/settings";
import { confidentMatch, matchPlans, metadataQuery, queueAutomaticTargets, queueTarget, recordFor, runMetadataJob } from "../src/metadata/automation";
import { mediaLibrary } from "../src/library-instance";
import { MetadataCandidate } from "../src/metadata/types";

const previousRoots = [config.mediaSourceRoot, config.mediaLibraryRoot];
let temporary: string, admin: TestUser, user: TestUser;
let fetch: ReturnType<typeof vi.spyOn>;
const movie = { id: 123, title: "Sintel", release_date: "2010-09-30", overview: "Provider overview", poster_path: "/fixture.jpg", backdrop_path: "/backdrop.jpg", adult: false,
  genres: [{ id: 1, name: "Fantasy" }], runtime: 15, vote_average: 7.4, vote_count: 50, credits: { cast: [{ name: "Fixture Actor" }] }, external_ids: { imdb_id: "tt1727587" } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function upstream(candidates: unknown[] = [movie]) {
  fetch.mockImplementation(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/search/")) return json({ results: candidates });
    if (url.pathname === "/3/authentication") return json({ success: true });
    if (url.pathname === "/3/movie/123") return json(movie);
    throw Error("Unexpected metadata fixture request");
  });
}
async function entry(name = "Sintel", source = "Sintel.2010.mp4") {
  await fs.writeFile(path.join(config.mediaSourceRoot, source), "original non-playable fixture");
  return mediaLibrary.add({ name, year: 2010, type: "movie", sourcePath: source });
}
const descriptor = (item: Awaited<ReturnType<typeof entry>>) => ({ targetType: "library" as const, targetId: item.id, name: item.media.name, mediaType: "movie" as const, year: item.media.year ?? null });
beforeEach(async () => {
  await resetDb(); temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metadata-automation-"));
  config.mediaSourceRoot = path.join(temporary, "source"); config.mediaLibraryRoot = path.join(temporary, "exports");
  await fs.mkdir(config.mediaSourceRoot); admin = await signup("admin");
  await saveMetadataSettings({ tmdbApiKey: `fixture-${randomUUID()}` });
  fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unplanned upstream request"));
});
afterEach(async () => { vi.restoreAllMocks(); [config.mediaSourceRoot, config.mediaLibraryRoot] = previousRoots; await fs.rm(temporary, { recursive: true, force: true }); });

it("requires a live admin and keeps settings private without contacting a provider", async () => {
  user = await signup("member");
  expect((await request(app).get("/api/admin/metadata/settings")).status).toBe(401);
  expect((await request(app).get("/api/admin/metadata/settings").set(auth(user.token))).status).toBe(403);
  const response = await request(app).get("/api/admin/metadata/settings").set(auth(admin.token));
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.body.settings).toMatchObject({ tmdbConfigured: true, automatic: false });
  expect(JSON.stringify(response.body)).not.toContain((await getMetadataSettings()).tmdbApiKey);
  expect(fetch).not.toHaveBeenCalled();
  await db.user.update({ where: { id: admin.id }, data: { role: "user" } });
  expect((await request(app).post("/api/admin/metadata/scan").set(auth(admin.token)).send({})).status).toBe(403);
});
it("validates search/selection and returns normalized previews without saving a match", async () => {
  upstream();
  expect((await request(app).post("/api/admin/metadata/search").set(auth(admin.token)).send({ query: "x", type: "movie", provider: "https://private.invalid" })).status).toBe(400);
  expect((await request(app).post("/api/admin/metadata/preview").set(auth(admin.token)).send({ provider: "tmdb", id: "../../authentication", type: "movie" })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  const search = await request(app).post("/api/admin/metadata/search").set(auth(admin.token)).send({ query: "Sintel", type: "movie", year: 2010 });
  expect(search.body.results[0]).toMatchObject({ provider: "tmdb", id: "123", year: 2010 });
  const preview = await request(app).post("/api/admin/metadata/preview").set(auth(admin.token)).send({ provider: "tmdb", id: "123", type: "movie" });
  expect(preview.body.metadata).toMatchObject({ cast: ["Fixture Actor"], imdbId: "tt1727587", runtimeMinutes: 15 });
  expect(await db.metadataRecord.count()).toBe(0);
});
it("does no automatic work when disabled, but explicit scans still run as durable manual jobs", async () => {
  upstream(); const item = await entry();
  await queueAutomaticTargets([descriptor(item)]); expect(await db.metadataRecord.count()).toBe(0); expect(await runMetadataJob()).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  const scan = await request(app).post("/api/admin/metadata/scan").set(auth(admin.token)).send({ targetType: "library", limit: 1 });
  expect(scan.status).toBe(200); expect(scan.body.queued).toBe(1); expect(fetch).not.toHaveBeenCalled();
  expect((await recordFor("library", item.id))?.requestedBy).toBe("manual");
  expect(await runMetadataJob()).toBe(true); expect((await recordFor("library", item.id))?.status).toBe("matched");
});
it("automatically enriches enabled exports without changing scanner names, symlinks or source bytes", async () => {
  upstream(); await saveMetadataSettings({ automatic: true });
  await fs.writeFile(path.join(config.mediaSourceRoot, "video.mp4"), "original non-playable fixture");
  const created = await request(app).post("/api/admin/library/entries").set(auth(admin.token)).send({ name: "Sintel", year: 2010, type: "movie", sourcePath: "video.mp4" });
  expect(created.status).toBe(201); expect(fetch).not.toHaveBeenCalled();
  const item = created.body.entry, scannerPath = path.join(config.mediaLibraryRoot, item.libraryPath), link = await fs.readlink(scannerPath);
  await runMetadataJob();
  const listing = await request(app).get("/api/admin/library").set(auth(admin.token));
  expect(listing.body.entries[0]).toMatchObject({ id: item.id, libraryPath: item.libraryPath, metadataStatus: "matched", metadata: { description: "Provider overview", ratingSource: "TMDB" } });
  expect(await fs.readlink(scannerPath)).toBe(link); expect(await fs.readFile(scannerPath, "utf8")).toBe("original non-playable fixture");
  expect((await mediaLibrary.list()).entries[0].media.name).toBe("Sintel");
});
it("puts duplicate/remake matches in review and does not repeatedly rescan an unmatched target", async () => {
  const item = await entry(); await saveMetadataSettings({ automatic: true }); upstream([movie, { ...movie, id: 456 }]);
  await queueAutomaticTargets([descriptor(item)]); await runMetadataJob();
  expect((await recordFor("library", item.id))?.status).toBe("review"); expect(fetch).toHaveBeenCalledTimes(1);
  await queueAutomaticTargets([descriptor(item)]); expect(await runMetadataJob()).toBe(false);
  const other = await entry("No match", "other.mp4"); upstream([]); await queueAutomaticTargets([descriptor(other)]); await runMetadataJob();
  expect((await recordFor("library", other.id))?.status).toBe("unmatched");
  const calls = fetch.mock.calls.length; await queueAutomaticTargets([descriptor(other)]); await runMetadataJob(); expect(fetch.mock.calls.length).toBe(calls);
});
it("bounds scan pages, does not overwrite matched records, and validates cursors and limits", async () => {
  await entry(); await entry("Second", "second.mp4");
  const first = await request(app).post("/api/admin/metadata/scan").set(auth(admin.token)).send({ targetType: "library", limit: 1 });
  expect(first.body.queued).toBe(1); expect(first.body.nextCursor).toMatch(/^[a-f0-9]{32}$/);
  const second = await request(app).post("/api/admin/metadata/scan").set(auth(admin.token)).send({ targetType: "library", limit: 1, cursor: first.body.nextCursor });
  expect(second.body.queued).toBe(1); expect(second.body.nextCursor).toBeNull(); expect(await db.metadataRecord.count()).toBe(2);
  for (const body of [{ limit: 101 }, { cursor: "../../bad" }]) expect((await request(app).post("/api/admin/metadata/scan").set(auth(admin.token)).send(body)).status).toBe(400);
  const records = await request(app).get("/api/admin/metadata/records?limit=1").set(auth(admin.token));
  expect(records.body.records).toHaveLength(1); expect(records.body.nextCursor).toBeTruthy(); expect(records.body.summary.queued).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});
it("pauses automatic jobs after opt-out while allowing explicit refresh", async () => {
  upstream(); const item = await entry(); await saveMetadataSettings({ automatic: true }); await queueAutomaticTargets([descriptor(item)]);
  await saveMetadataSettings({ automatic: false }); expect(await runMetadataJob()).toBe(false); expect(fetch).not.toHaveBeenCalled();
  const refresh = await request(app).post(`/api/admin/metadata/records/library/${item.id}/refresh`).set(auth(admin.token)).send({});
  expect(refresh.status).toBe(200); await runMetadataJob(); expect((await recordFor("library", item.id))?.status).toBe("matched");
});
it("claims each queued job once and recovers an expired process lease", async () => {
  upstream(); const item = await entry(); const record = await queueTarget(descriptor(item), true);
  await Promise.all([runMetadataJob(), runMetadataJob()]); expect((await recordFor("library", item.id))?.attempts).toBe(1); expect(fetch).toHaveBeenCalledTimes(2);
  await db.metadataRecord.update({ where: { id: record!.id }, data: { status: "processing", leaseUntil: new Date(Date.now() - 1000) } });
  await runMetadataJob(); expect((await recordFor("library", item.id))?.status).toBe("matched"); expect((await recordFor("library", item.id))?.attempts).toBe(2);
});
it("keeps authentication failures terminal until explicit retry instead of rescheduling each discovery pass", async () => {
  const item = await entry(); await saveMetadataSettings({ automatic: true }); fetch.mockResolvedValue(json({ error: "secret credentials should never leak" }, 401));
  await queueAutomaticTargets([descriptor(item)]); await runMetadataJob();
  expect(await recordFor("library", item.id)).toMatchObject({ status: "error", attempts: 1 });
  const failed = (await recordFor("library", item.id))!; expect(failed.error).not.toContain("secret");
  await queueAutomaticTargets([descriptor(item)]); expect(await runMetadataJob(new Date(Date.now() + 3600000))).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
});
it("backs off provider-wide after rate limiting, retains bounded attempts and resumes with a rotated key", async () => {
  const item = await entry(); await queueTarget(descriptor(item), true); fetch.mockImplementation(async () => json({}, 429));
  await runMetadataJob(); const failed = (await recordFor("library", item.id))!;
  expect(failed).toMatchObject({ status: "queued", attempts: 1 }); expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 200000);
  const other = await entry("Second", "second.mp4"); await queueTarget(descriptor(other), true); expect(await runMetadataJob()).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  await saveMetadataSettings({ tmdbApiKey: `rotated-${randomUUID()}` }); upstream(); expect(await runMetadataJob()).toBe(true); expect(fetch.mock.calls.length).toBeGreaterThan(1);
});
it("refreshes an OMDb match with its own credentials even when the preferred TMDB key is absent", async () => {
  const item = await entry(); await saveMetadataSettings({ clearTmdb: true, omdbApiKey: `fixture-${randomUUID()}` });
  fetch.mockImplementation(async () => json({ Response: "True", imdbID: "tt1727587", Type: "movie", Title: "Sintel", Year: "2010", Plot: "OMDb overview", Genre: "Fantasy", Actors: "Fixture Actor", Runtime: "15 min", imdbRating: "7.4" }));
  const matched = await request(app).post(`/api/admin/metadata/records/library/${item.id}/match`).set(auth(admin.token)).send({ provider: "omdb", id: "tt1727587", type: "movie" }); expect(matched.status).toBe(200);
  const refresh = await request(app).post(`/api/admin/metadata/records/library/${item.id}/refresh`).set(auth(admin.token)).send({}); expect(refresh.status).toBe(200);
  await runMetadataJob(); expect((await recordFor("library", item.id))?.status).toBe("matched"); expect(fetch).toHaveBeenCalledTimes(2);
});
it("rejects stale revisions and preserves locked artwork on a confirmed replacement", async () => {
  upstream(); const item = await entry();
  const locked = await request(app).patch(`/api/admin/metadata/records/library/${item.id}/locks`).set(auth(admin.token)).send({ lockedFields: ["posterUrl"] });
  expect(locked.status).toBe(200);
  const stale = await request(app).post(`/api/admin/metadata/records/library/${item.id}/match`).set(auth(admin.token)).send({ provider: "tmdb", id: "123", type: "movie", expectedRevision: locked.body.record.revision - 1 }); expect(stale.status).toBe(409); expect(fetch).not.toHaveBeenCalled();
  const matched = await request(app).post(`/api/admin/metadata/records/library/${item.id}/match`).set(auth(admin.token)).send({ provider: "tmdb", id: "123", type: "movie", expectedRevision: locked.body.record.revision });
  expect(matched.status).toBe(200); expect(matched.body.record.data.posterUrl).toBeNull(); expect(matched.body.record.data.description).toBe("Provider overview");
});
it("does not resurrect a library entry deleted while its metadata details are in flight", async () => {
  const item = await entry(); await queueTarget(descriptor(item), true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  fetch.mockImplementation(async (input: unknown) => { if (String(input).includes("/search/")) return json({ results: [movie] }); entered(); await gate; return json(movie); });
  const work = runMetadataJob(); await started;
  const removed = await request(app).delete(`/api/admin/library/entries/${item.id}`).set(auth(admin.token)); expect(removed.status).toBe(200);
  release(); await work; expect(await recordFor("library", item.id)).toBeNull(); expect(await fs.readFile(path.join(config.mediaSourceRoot, "Sintel.2010.mp4"), "utf8")).toBe("original non-playable fixture");
});
it("discards a search after automatic settings change before sending its detail request", async () => {
  const item = await entry(); await saveMetadataSettings({ automatic: true }); await queueAutomaticTargets([descriptor(item)]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  fetch.mockImplementation(async () => { entered(); await gate; return json({ results: [movie] }); });
  const work = runMetadataJob(); await started; await saveMetadataSettings({ language: "fr-CA" }); release(); await work;
  expect(fetch).toHaveBeenCalledTimes(1); expect((await recordFor("library", item.id))?.status).toBe("queued");
});
it("normalizes release tokens without stripping genuine numeric title suffixes and refuses ambiguous identities", () => {
  expect(metadataQuery("Sintel.2010.1080p.mkv", 2010)).toBe("Sintel");
  expect(metadataQuery("Wonder Woman 1984", 2020)).toBe("Wonder Woman 1984");
  const candidate: MetadataCandidate = { provider: "tmdb", id: "123", type: "movie", name: "Sintel", year: 2010, posterUrl: null, description: "" };
  const target = { targetType: "library" as const, targetId: "fixture", name: "Sintel", mediaType: "movie" as const, year: 2010 };
  expect(confidentMatch(target, [candidate])).toBe(candidate); expect(confidentMatch(target, [candidate, { ...candidate, id: "2" }])).toBeNull();
  expect(confidentMatch({ ...target, year: null }, [candidate])).toBe(candidate);
  expect(confidentMatch({ ...target, year: null }, [candidate, { ...candidate, id: "2", year: 2020 }])).toBeNull();
});

it("cuts release names at the title so editions, audio and quality tags do not defeat automatic matching", () => {
  const plan = (name: string, year?: number | null) => matchPlans(name, year)[0];
  expect(plan("Crank 2006 Director's Cut 1080p BluRay DTS x264-CtrlHD.mkv")).toEqual({ query: "Crank", year: 2006 });
  expect(plan("Crank.2006.Directors.Cut.1080p.BluRay.DTS.x264-CtrlHD.mkv", 2006)).toEqual({ query: "Crank", year: 2006 });
  expect(plan("Blade Runner 2049 2017 2160p UHD BluRay x265")).toEqual({ query: "Blade Runner 2049", year: 2017 });
  expect(plan("Mr Morfina (2025) [1080p] [WEBRip]")).toEqual({ query: "Mr Morfina", year: 2025 });
  expect(plan("Show.Name.S02E05.720p.HDTV.x264")).toEqual({ query: "Show Name", year: null });
  // A trailing number may be part of the title, so an unhinted name also offers the uncut query.
  expect(matchPlans("Wonder Woman 1984")).toEqual([{ query: "Wonder Woman", year: 1984 }, { query: "Wonder Woman 1984", year: null }]);
  const movie = (name: string, year: number, id = "1"): MetadataCandidate => ({ provider: "tmdb", id, type: "movie", name, year, posterUrl: null, description: "" });
  const target = (name: string, year: number | null) => ({ targetType: "account" as const, targetId: "x", name, mediaType: "movie" as const, year });
  const crank = "Crank 2006 Director's Cut 1080p BluRay DTS x264-CtrlHD.mkv";
  expect(confidentMatch(target(crank, null), [movie("Crank", 2006), movie("Crank: High Voltage", 2009, "2")], plan(crank))?.id).toBe("1");
  expect(confidentMatch(target("Safe", 2012), [movie("Safe", 2013)])?.id).toBe("1"); // one near-year title
  expect(confidentMatch(target("Safe", 2012), [movie("Safe", 2011), movie("Safe", 2013, "2")])).toBeNull();
  expect(confidentMatch(target("Safe", 2012), [movie("Safe", 2012), movie("Safe", 2012, "2")])).toBeNull();
  expect(confidentMatch(target("Dune", null), [movie("Dune", 2021), movie("Dune: Part Two", 2024, "3")])?.id).toBe("1"); // one exact title
  expect(confidentMatch(target("Dune", null), [movie("Dune", 2021), movie("Dune", 1984, "2")])).toBeNull(); // a remake stays in review
});

it("caps transient retries at three attempts without automatic budget resets", async () => {
  const item = await entry(); await queueTarget(descriptor(item), true);
  fetch.mockImplementation(async () => json({ error: "Temporary upstream outage" }, 503));
  const initial = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runMetadataJob(new Date(initial + (attempt - 1) * 600000));
    expect(await recordFor("library", item.id)).toMatchObject({ attempts: attempt, status: attempt < 3 ? "queued" : "error" });
  }
  expect(await runMetadataJob(new Date(initial + 3600000))).toBe(false); expect(fetch).toHaveBeenCalledTimes(3);
});
it("discards fetched details if the provider language changes before commit", async () => {
  const item = await entry(); await queueTarget(descriptor(item), true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  fetch.mockImplementation(async (input: unknown) => { if (String(input).includes("/search/")) return json({ results: [movie] }); entered(); await gate; return json(movie); });
  const work = runMetadataJob(); await started; await saveMetadataSettings({ language: "fr-CA" }); release(); await work;
  expect(fetch).toHaveBeenCalledTimes(2); expect(await recordFor("library", item.id)).toMatchObject({ status: "queued", data: "{}" });
});
