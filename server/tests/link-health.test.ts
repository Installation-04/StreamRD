import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { accountProviderContext, AccountLibraryError, playImportedMedia } from "../src/account-library";
import { playAccountItem } from "../src/providers/account-library";
import { ProviderError } from "../src/providers/types";
import { checkItem, dueItems, ensureReplacement, linkHealthSummary, runLinkHealthJob } from "../src/link-health";
import { refreshPrimaries } from "../src/versions";
vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const play = vi.mocked(playAccountItem);
const HOUR = 3_600_000;
let serial = 0;

async function owner(role: "user" | "admin" = "admin") {
  const user = await db.user.create({ data: { email: `link-health-${serial++}@example.invalid`, displayName: "Library owner", hashedPassword: "fixture-no-password-auth", role } });
  await db.debridConfig.create({ data: { userId: user.id, realDebridToken: "private-fixture-key", autoImportLibrary: false } });
  return { ...user, token: signSession({ sub: user.id, email: user.email, role, version: user.sessionVersion }) };
}
async function item(userId: string, name = "Example Movie", extra: Record<string, unknown> = {}) {
  const ctx = await accountProviderContext(userId, "realdebrid");
  return db.accountMedia.create({ data: { userId, provider: "realdebrid", providerRef: `ref-${serial++}`, credentialFingerprint: ctx.fingerprint, name, year: 2020, phase: "finished", progress: 100, groupKey: `imdb:tt${1000000 + serial}`, ...extra } });
}
const works = () => play.mockResolvedValue({ stream: { provider: "realdebrid", url: "https://cdn.example.invalid/video.mkv", filename: "video.mkv" } });
const gone = () => play.mockRejectedValue(new ProviderError("realdebrid", "This item is no longer available in the provider account.", 404));
const answers = (status: number) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
const health = async (id: string) => db.accountMedia.findUniqueOrThrow({ where: { id }, select: { health: true, healthFailures: true, healthCheckedAt: true, isPrimary: true } });
const details = (imdbId: string) => ({ provider: "tmdb", id: "1", type: "movie", name: "Example Movie", year: 2020, posterUrl: null, description: null, genres: [], backdropUrl: null, cast: [], runtimeMinutes: null, rating: null, ratingSource: null, contentRating: null, imdbId, tmdbId: "1", providerUrl: "https://example.invalid/1", fetchedAt: new Date().toISOString() });
const matched = (itemId: string, ownerId: string, imdbId: string) => db.metadataRecord.create({ data: { targetType: "account", targetId: itemId, ownerId, name: "Example Movie", mediaType: "movie", status: "matched", requestedBy: "automatic", data: JSON.stringify(details(imdbId)) } });

beforeEach(async () => { await resetDb(); vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it("records a working link and checks it again only after a day", async () => {
  const admin = await owner(), row = await item(admin.id); works(); answers(200);
  expect(await checkItem(row.id)).toBe("ok");
  expect(await health(row.id)).toMatchObject({ health: "ok", healthFailures: 0 });
  expect(await dueItems(10)).toHaveLength(0);
  await db.accountMedia.update({ where: { id: row.id }, data: { healthCheckedAt: new Date(Date.now() - 25 * HOUR) } });
  expect((await dueItems(10)).map(r => r.id)).toEqual([row.id]);
});

it("needs two 'gone' answers in a row to call a link broken, and one good answer to recover it", async () => {
  const admin = await owner(), row = await item(admin.id); gone();
  expect(await checkItem(row.id)).toBe("unknown");
  expect(await health(row.id)).toMatchObject({ health: "unknown", healthFailures: 1 });
  expect(await checkItem(row.id)).toBe("broken");
  expect(await health(row.id)).toMatchObject({ health: "broken", healthFailures: 2 });
  works(); answers(200);
  expect(await checkItem(row.id)).toBe("ok");
  expect(await health(row.id)).toMatchObject({ health: "ok", healthFailures: 0 });
});

it("treats a link that answers 404 as gone, and timeouts, rate limits and downloads as no news", async () => {
  const admin = await owner(), row = await item(admin.id); works(); answers(404);
  await checkItem(row.id); expect((await health(row.id)).healthFailures).toBe(1);
  vi.restoreAllMocks(); works(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout")); await checkItem(row.id);
  play.mockRejectedValue(new ProviderError("realdebrid", "slow down", 429)); await checkItem(row.id);
  play.mockResolvedValue({ pending: true, progress: 40 }); await checkItem(row.id);
  expect((await health(row.id)).healthFailures).toBe(1); // unchanged by the inconclusive checks
  expect((await health(row.id)).healthCheckedAt).not.toBeNull();
});

it("never shows a broken version as the card while another version works, and brings it back when it recovers", async () => {
  const admin = await owner(), key = "imdb:tt0111161";
  const older = await item(admin.id, "Example Movie", { groupKey: key, createdAt: new Date(Date.now() - 5 * HOUR), isPrimary: false });
  const newer = await item(admin.id, "Example Movie", { groupKey: key, createdAt: new Date(), isPrimary: true });
  gone(); await checkItem(newer.id); await checkItem(newer.id);
  expect((await health(newer.id)).health).toBe("broken");
  expect((await health(older.id)).isPrimary).toBe(true); expect((await health(newer.id)).isPrimary).toBe(false);
  expect(await ensureReplacement(newer.id)).toBe("switched"); expect(await db.mediaRequest.count()).toBe(0);
  works(); answers(200); await checkItem(newer.id);
  expect((await health(newer.id)).isPrimary).toBe(true); expect((await health(older.id)).isPrimary).toBe(false);
});

it("requests a replacement, once, when the only working copy of an identified title is gone", async () => {
  const admin = await owner(), row = await item(admin.id, "Example Movie", { groupKey: "imdb:tt0111161" }); await matched(row.id, admin.id, "tt0111161"); gone();
  await checkItem(row.id); await checkItem(row.id); await checkItem(row.id);
  const requests = await db.mediaRequest.findMany({ include: { followers: true, events: true } });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ status: "requested", canonicalKey: "imdb:movie:tt0111161", name: "Example Movie" });
  expect(requests[0].followers.map(f => f.userId)).toEqual([admin.id]); expect(requests[0].events).toHaveLength(1);
});

it("reopens an earlier finished request for the title, but never one an administrator rejected", async () => {
  const admin = await owner(), row = await item(admin.id, "Example Movie", { groupKey: "imdb:tt0111161" }); await matched(row.id, admin.id, "tt0111161");
  const base = { canonicalKey: "imdb:movie:tt0111161", provider: "tmdb", externalId: "1", mediaType: "movie", name: "Example Movie", year: 2020, metadata: "{}" };
  await db.mediaRequest.create({ data: { ...base, status: "available", providerRef: "old", progress: 100 } });
  gone(); await checkItem(row.id); await checkItem(row.id);
  expect(await db.mediaRequest.findUniqueOrThrow({ where: { canonicalKey: base.canonicalKey } })).toMatchObject({ status: "requested", providerRef: null, progress: null, revision: 1 });
  await db.mediaRequest.update({ where: { canonicalKey: base.canonicalKey }, data: { status: "rejected" } });
  expect(await ensureReplacement(row.id)).toBe("none");
  expect((await db.mediaRequest.findUniqueOrThrow({ where: { canonicalKey: base.canonicalKey } })).status).toBe("rejected");
});

it("asks for nothing when the title has no confirmed identity, and leaves the item stored", async () => {
  const admin = await owner(), row = await item(admin.id); gone();
  await checkItem(row.id); await checkItem(row.id);
  expect((await health(row.id)).health).toBe("broken"); expect(await db.mediaRequest.count()).toBe(0); expect(await db.accountMedia.count()).toBe(1);
});

it("checks a few due items per run, oldest first, and ignores members' items and items that are still downloading", async () => {
  const admin = await owner(), member = await owner("user"); works(); answers(200);
  const rows = [];
  for (let index = 0; index < 4; index++) rows.push(await item(admin.id, `Movie ${index}`, { healthCheckedAt: new Date(Date.now() - (10 - index) * HOUR), health: "unknown" }));
  const memberItem = await item(member.id), downloading = await item(admin.id, "Downloading", { phase: "downloading", progress: 30 });
  expect(await runLinkHealthJob(2)).toBe(2);
  expect((await health(rows[0].id)).health).toBe("ok"); expect((await health(rows[1].id)).health).toBe("ok"); expect((await health(rows[2].id)).health).toBe("unknown");
  expect((await health(memberItem.id)).healthCheckedAt).toBeNull(); expect((await health(downloading.id)).healthCheckedAt).toBeNull();
});

it("learns from playback: two failed plays break the link, a good play heals it", async () => {
  const admin = await owner(), row = await item(admin.id); gone();
  await expect(playImportedMedia(admin.id, row.id)).rejects.toBeInstanceOf(AccountLibraryError);
  await expect(playImportedMedia(admin.id, row.id)).rejects.toBeInstanceOf(AccountLibraryError);
  expect((await health(row.id)).health).toBe("broken");
  works(); await playImportedMedia(admin.id, row.id);
  expect(await health(row.id)).toMatchObject({ health: "ok", healthFailures: 0 });
});

it("shows administrators the summary and a check-now button, and nobody else", async () => {
  const admin = await owner(), other = await owner(), member = await owner("user"), good = await item(admin.id, "Good"), bad = await item(admin.id, "Bad", { health: "broken", healthFailures: 2, healthError: "The link answers 404", healthCheckedAt: new Date() });
  await db.accountMedia.update({ where: { id: good.id }, data: { health: "ok" } });
  const summary = await request(app).get("/api/account/library/health").set(auth(admin.token));
  expect(summary.status).toBe(200); expect(summary.body).toMatchObject({ ok: 1, broken: 1, unknown: 0 }); expect(summary.body.items[0]).toMatchObject({ id: bad.id, name: "Bad", reason: "The link answers 404" });
  expect(JSON.stringify(summary.body)).not.toMatch(/providerRef|credentialFingerprint|private-fixture-key/);
  expect((await request(app).get("/api/account/library/health").set(auth(member.token))).status).toBe(403);
  const listed = await request(app).get("/api/account/library").set(auth(admin.token));
  expect(listed.body.items.find((row: { id: string }) => row.id === bad.id).health).toBe("broken");
  works(); answers(200);
  const checked = await request(app).post(`/api/account/library/${bad.id}/check`).set(auth(admin.token)).send({});
  expect(checked.status).toBe(200); expect(checked.body.health).toBe("ok");
  expect((await request(app).post(`/api/account/library/${good.id}/check`).set(auth(other.token)).send({})).status).toBe(404);
  expect((await request(app).post(`/api/account/library/${good.id}/check`).set(auth(member.token)).send({})).status).toBe(403);
  expect((await linkHealthSummary()).broken).toBe(0);
});

it("keeps primaries stable for titles that never needed health", async () => {
  const admin = await owner(), a = await item(admin.id, "Same", { groupKey: "k:1", createdAt: new Date(Date.now() - HOUR) }), b = await item(admin.id, "Same", { groupKey: "k:1" });
  await refreshPrimaries(db, admin.id, ["k:1"]);
  expect((await health(b.id)).isPrimary).toBe(true); expect((await health(a.id)).isPrimary).toBe(false);
});
