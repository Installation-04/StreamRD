import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { app, adminAndUser, auth, resetDb, TestUser } from "./helpers";
import { db } from "../src/db";
import { getMetadataSettings, saveMetadataSettings } from "../src/metadata/settings";
import { decorateAccountMedia, queueImportedMetadata } from "../src/metadata/account";
import { queueTarget, recordFor, runMetadataJob } from "../src/metadata/automation";

let admin: TestUser, user: TestUser, item: Awaited<ReturnType<typeof db.accountMedia.create>>, fetch: ReturnType<typeof vi.spyOn>;
const movie = { id: 123, title: "Sintel", release_date: "2010-09-30", overview: "Provider overview", poster_path: "/fixture.jpg", adult: false,
  genres: [{ name: "Fantasy" }], runtime: 15, vote_average: 7.4, vote_count: 50, credits: { cast: [{ name: "Fixture Actor" }] }, external_ids: { imdb_id: "tt1727587" } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
beforeEach(async () => {
  await resetDb(); ({ admin, user } = await adminAndUser()); await db.user.update({ where: { id: user.id }, data: { role: "admin" } }); // only administrators import (v0.18.0)
  item = await db.accountMedia.create({ data: { userId: user.id, provider: "realdebrid", providerRef: "private-existing-reference", credentialFingerprint: "f".repeat(64), name: "Sintel", type: "movie", year: 2010, phase: "finished", progress: 100 } });
  await saveMetadataSettings({ tmdbApiKey: `private-metadata-${randomUUID()}` });
  fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => json(String(input).includes("/search/") ? { results: [movie] } : movie));
});
afterEach(() => { vi.restoreAllMocks(); });
it("keeps personal matching owner-only even against another administrator", async () => {
  const route = `/api/account/library/${item.id}/metadata`;
  expect((await request(app).get(route)).status).toBe(401);
  expect((await request(app).get(route).set(auth(admin.token))).status).toBe(404);
  expect((await request(app).post(`${route}/search`).set(auth(admin.token)).send({ query: "Sintel", type: "movie" })).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  const owned = await request(app).get(route).set(auth(user.token)); expect(owned.status).toBe(200); expect(owned.body.record).toBeNull(); expect(owned.headers["cache-control"]).toContain("no-store");
});
it("allows a member to preview and confirm metadata using server-only keys without changing provider references", async () => {
  const route = `/api/account/library/${item.id}/metadata`;
  const result = await request(app).post(`${route}/search`).set(auth(user.token)).send({ query: "Sintel", type: "movie", year: 2010 }); expect(result.status).toBe(200);
  const preview = await request(app).post(`${route}/preview`).set(auth(user.token)).send({ provider: "tmdb", id: "123", type: "movie" }); expect(preview.status).toBe(200);
  const matched = await request(app).post(`${route}/match`).set(auth(user.token)).send({ provider: "tmdb", id: "123", type: "movie" }); expect(matched.status).toBe(200);
  expect(matched.body.record.data).toMatchObject({ imdbId: "tt1727587", cast: ["Fixture Actor"] });
  expect(JSON.stringify(matched.body)).not.toContain((await getMetadataSettings()).tmdbApiKey);
  expect(JSON.stringify(matched.body)).not.toContain("ownerId");
  expect(await db.accountMedia.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ userId: user.id, providerRef: "private-existing-reference", credentialFingerprint: "f".repeat(64) });
  expect((await recordFor("account", item.id))?.ownerId).toBe(user.id);
});
it("excludes private title names and totals from shared administrator matching activity", async () => {
  const matched = await request(app).post(`/api/account/library/${item.id}/metadata/match`).set(auth(user.token)).send({ provider: "tmdb", id: "123", type: "movie" }); expect(matched.status).toBe(200);
  const activity = await request(app).get("/api/admin/metadata/records").set(auth(admin.token));
  expect(activity.status).toBe(200); expect(activity.body.records).toEqual([]); expect(activity.body.summary.matched).toBe(0); expect(JSON.stringify(activity.body)).not.toContain(item.name);
  expect((await request(app).get(`/api/admin/metadata/records/account/${item.id}`).set(auth(admin.token))).status).toBe(404);
});
it("queues imported account titles only after metadata automation is enabled and decorates only the owner", async () => {
  await queueImportedMetadata([item]); expect(await recordFor("account", item.id)).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  await saveMetadataSettings({ automatic: true }); await queueImportedMetadata([item]); await runMetadataJob();
  expect((await recordFor("account", item.id))?.status).toBe("matched");
  const decorated = await decorateAccountMedia([item]); expect(decorated[0].metadata?.imdbId).toBe("tt1727587");
  const unrelated = await decorateAccountMedia([{ ...item, userId: admin.id }]); expect(unrelated[0].metadata).toBeNull(); expect(unrelated[0].metadataStatus).toBeNull();
});
it("cascades account metadata and queued work when the account is deleted", async () => {
  await queueTarget({ targetType: "account", targetId: item.id, ownerId: user.id, name: item.name, mediaType: "movie", year: item.year }, true);
  expect(await db.metadataRecord.count()).toBe(1); await db.user.delete({ where: { id: user.id } });
  expect(await db.accountMedia.count()).toBe(0); expect(await db.metadataRecord.count()).toBe(0); expect(await runMetadataJob()).toBe(false); expect(fetch).not.toHaveBeenCalled();
});

it("stops private matching before a second provider request when the owner is deactivated", async () => {
  await queueTarget({ targetType: "account", targetId: item.id, ownerId: user.id, name: item.name, mediaType: "movie", year: item.year }, true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  fetch.mockImplementation(async () => { entered(); await gate; return json({ results: [movie] }); });
  const work = runMetadataJob(); await started; await db.user.update({ where: { id: user.id }, data: { active: false } }); release(); await work;
  expect(fetch).toHaveBeenCalledTimes(1); expect(await recordFor("account", item.id)).toMatchObject({ status: "error", data: "{}" });
});

async function extraItem(name: string, year: number | null, ref: string) {
  return db.accountMedia.create({ data: { userId: user.id, provider: "realdebrid", providerRef: ref, credentialFingerprint: "f".repeat(64), name, type: "movie", year, phase: "finished", progress: 100 } });
}
it("summarizes only the caller's library and retries unmatched, failed and never-started titles", async () => {
  const stuck = await extraItem("Crank 2006 Director's Cut 1080p BluRay DTS x264-CtrlHD.mkv", null, "stuck-ref"), fresh = await extraItem("Sintel 2010 1080p", null, "fresh-ref");
  await db.metadataRecord.create({ data: { targetType: "account", targetId: stuck.id, ownerId: user.id, name: stuck.name, mediaType: "movie", year: null, status: "review", requestedBy: "automatic", error: "Review the possible matches before applying metadata." } });
  const before = await request(app).get("/api/account/library/metadata/summary").set(auth(user.token));
  expect(before.status).toBe(200); expect(before.headers["cache-control"]).toContain("no-store");
  expect(before.body).toMatchObject({ total: 3, review: 1, matched: 0, notStarted: 2, provider: { configured: true, automatic: false } });
  expect(JSON.stringify(before.body)).not.toMatch(/Crank|Sintel|private-metadata/);
  // Another member's summary and retry never see or touch these records.
  const other = await request(app).get("/api/account/library/metadata/summary").set(auth(admin.token));
  expect(other.body).toMatchObject({ total: 0, review: 0, notStarted: 0 });
  expect((await request(app).post("/api/account/library/metadata/rematch").set(auth(admin.token))).body.queued).toBe(0);
  expect((await request(app).get("/api/account/library/metadata/summary")).status).toBe(401);

  fetch.mockImplementation(async (input: unknown) => json(String(input).includes("/search/") ? { results: [{ ...movie, title: String(input).includes("Crank") ? "Crank" : "Sintel", release_date: String(input).includes("Crank") ? "2006-08-31" : "2010-09-30" }] } : movie));
  const retried = await request(app).post("/api/account/library/metadata/rematch").set(auth(user.token));
  expect(retried.status).toBe(200); expect(retried.body).toMatchObject({ queued: 3, configured: true });
  for (let step = 0; step < 6; step++) await runMetadataJob();
  const after = (await request(app).get("/api/account/library/metadata/summary").set(auth(user.token))).body;
  expect(after).toMatchObject({ matched: 3, review: 0, unmatched: 0, notStarted: 0 });
  const queries = fetch.mock.calls.map((call: unknown[]) => decodeURIComponent(String(call[0]))).filter((url: string) => url.includes("/search/"));
  expect(queries.some((url: string) => /query=Crank(&|$)/.test(url))).toBe(true); // the title is searched without edition or quality tags
});
it("retries with the built-in source when no provider key is saved, queuing locally without calling any provider", async () => {
  await saveMetadataSettings({ clearTmdbApiKey: true } as never).catch(() => undefined);
  await db.setting.deleteMany({ where: { key: { startsWith: "metadata." } } });
  fetch.mockClear();
  const response = await request(app).post("/api/account/library/metadata/rematch").set(auth(user.token));
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ queued: 1 }); expect(fetch).not.toHaveBeenCalled();
});
