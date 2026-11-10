import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as accountMetadata from "../src/metadata/account";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { queueAccountScans, runAccountLibraryJob, setAccountImportHook } from "../src/account-library";
import { playAccountItem, scanAccountPage } from "../src/providers/account-library";
import { AccountPlayResult } from "../src/providers/account-library";
import { getSharedSetupState } from "../src/shared-libraries";

vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const scan = vi.mocked(scanAccountPage), play = vi.mocked(playAccountItem);
let serial = 0;
async function user(role: "admin" | "user" = "user") {
  const user = await db.user.create({ data: { email: `shared-${serial++}@example.invalid`, displayName: role === "admin" ? "Server owner" : "Invited member", hashedPassword: "fixture-no-password-auth", role } });
  return { ...user, token: signSession({ sub: user.id, email: user.email, role, version: user.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
async function imports(owner: User) {
  await db.debridConfig.create({ data: { userId: owner.id, realDebridToken: "server-only-private-key" } });
  scan.mockResolvedValue({ items: [
    { providerRef: "private-film-ref", name: "Server.Movie.2020.mkv", phase: "finished", progress: 100 },
    { providerRef: "private-show-ref", name: "Server.Show.S01E02.mkv", phase: "finished", progress: 100 },
  ], nextCursor: null });
  await queueAccountScans(owner.id); await runAccountLibraryJob();
  return db.accountMedia.findMany({ where: { userId: owner.id }, orderBy: { name: "asc" } });
}
async function library(owner: User, name = "Server movies", mediaType = "movie") {
  const response = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name, mediaType });
  expect(response.status).toBe(201);
  return response.body.library as { id: string; name: string; mediaType: string; itemCount: number };
}
async function grant(owner: User, libraryId: string, member: User) {
  expect((await request(app).post(`/api/admin/shared-libraries/${libraryId}/users`).set(auth(owner.token)).send({ userId: member.id })).status).toBe(200);
}
function playUrl(libraryId: string, itemId: string) { return `/api/shared-libraries/${libraryId}/items/${itemId}/play`; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const stream = { stream: { provider: "realdebrid" as const, url: "https://temporary-stream.invalid/?secret=never-persist", filename: "Film.mkv" } };
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); setAccountImportHook(null); });
afterEach(() => vi.restoreAllMocks());

it("requires authentication and source-owner administration, including among administrators", async () => {
  const owner = await user("admin"), other = await user("admin"), member = await user();
  const shared = await library(owner);
  expect((await request(app).get("/api/shared-libraries")).status).toBe(401);
  expect((await request(app).get("/api/admin/shared-libraries").set(auth(member.token))).status).toBe(403);
  expect((await request(app).post("/api/admin/shared-libraries").set(auth(member.token)).send({ name: "No" })).status).toBe(403);
  expect((await request(app).get("/api/admin/shared-libraries").set(auth(other.token))).body.libraries).toEqual([]);
  for (const method of ["patch", "delete"] as const) expect((await request(app)[method](`/api/admin/shared-libraries/${shared.id}`).set(auth(other.token)).send({ enabled: false })).status).toBe(404);
  expect((await request(app).post(`/api/admin/shared-libraries/${shared.id}/users`).set(auth(other.token)).send({ userId: other.id })).status).toBe(404);
  expect((await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Wrong source", sourceUserId: other.id })).status).toBe(400);
});
it("does not reveal shared names/counts or make provider requests before an explicit grant and Play", async () => {
  const owner = await user("admin"), member = await user(), [film] = await imports(owner), shared = await library(owner);
  scan.mockClear(); play.mockClear();
  const empty = await request(app).get("/api/shared-libraries").set(auth(member.token));
  expect(empty.body.libraries).toEqual([]); expect(JSON.stringify(empty.body)).not.toContain("Server movies");
  for (const suffix of ["/items", `/items/${film.id}`]) expect((await request(app).get(`/api/shared-libraries/${shared.id}${suffix}`).set(auth(member.token))).status).toBe(404);
  expect((await request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({})).status).toBe(404);
  expect(scan).not.toHaveBeenCalled(); expect(play).not.toHaveBeenCalled();
  await grant(owner, shared.id, member); await grant(owner, shared.id, member);
  expect(await db.sharedLibraryGrant.count()).toBe(1);
  const listing = await request(app).get("/api/shared-libraries").set(auth(member.token));
  expect(listing.body.libraries).toEqual([{ id: shared.id, name: shared.name, mediaType: shared.mediaType, itemCount: 1 }]);
  expect(listing.headers["cache-control"]).toContain("no-store");
  expect(scan).not.toHaveBeenCalled(); expect(play).not.toHaveBeenCalled();
});
it("shares only matching owned imports and sanitized metadata while the member's private library stays separate", async () => {
  const owner = await user("admin"), member = await user(), [film, show] = await imports(owner), shared = await library(owner);
  await grant(owner, shared.id, member);
  await db.metadataRecord.create({ data: { targetType: "account", targetId: film.id, ownerId: owner.id, name: film.name, mediaType: "movie", status: "matched", data: JSON.stringify({ provider: "tmdb", id: "1", type: "movie", name: "Matched film", description: "Shared description", genres: [], cast: [], fetchedAt: new Date().toISOString(), _applied: { name: "private ownership bookkeeping" } }) } });
  const response = await request(app).get(`/api/shared-libraries/${shared.id}/items`).set(auth(member.token));
  expect(response.status).toBe(200); expect(response.body.total).toBe(1); expect(response.body.items[0].id).toBe(film.id);
  expect(response.body.items[0].metadata.name).toBe("Matched film");
  expect(JSON.stringify(response.body)).not.toMatch(/private-film-ref|private-show-ref|server-only-private-key|credentialFingerprint|providerRef|userId|_applied|bookkeeping/);
  expect((await request(app).get(`/api/shared-libraries/${shared.id}/items/${show.id}`).set(auth(member.token))).status).toBe(404);
  expect((await request(app).post(playUrl(shared.id, show.id)).set(auth(member.token)).send({})).status).toBe(404);
  expect((await request(app).get("/api/account/library").set(auth(member.token))).status).toBe(403); // personal imports are administrator-only (v0.18.0)
  expect((await request(app).get(`/api/account/library/${film.id}`).set(auth(member.token))).status).toBe(403);
  expect((await request(app).post(`/api/account/library/${film.id}/metadata/search`).set(auth(member.token)).send({ q: "Film" })).status).toBe(403);
  expect(play).not.toHaveBeenCalled();
});
it("includes future imports, filters searches and binds pagination to member/library/search", async () => {
  const owner = await user("admin"), member = await user(), second = await user(); await imports(owner);
  const shared = await library(owner, "Everything", "all"), other = await library(owner, "Same source", "all");
  await grant(owner, shared.id, member); await grant(owner, shared.id, second); await grant(owner, other.id, member);
  const first = await request(app).get(`/api/shared-libraries/${shared.id}/items?limit=1`).set(auth(member.token));
  expect(first.status).toBe(200); expect(first.body.nextCursor).toBeTruthy();
  const next = await request(app).get(`/api/shared-libraries/${shared.id}/items`).query({ limit: 1, cursor: first.body.nextCursor }).set(auth(member.token));
  expect(next.status).toBe(200); expect(next.body.items[0].id).not.toBe(first.body.items[0].id);
  for (const [libraryId, token, q] of [[shared.id, second.token, undefined], [other.id, member.token, undefined], [shared.id, member.token, "Movie"]] as const) {
    expect((await request(app).get(`/api/shared-libraries/${libraryId}/items`).query({ cursor: first.body.nextCursor, ...(q ? { q } : {}) }).set(auth(token))).status).toBe(400);
  }
  expect((await request(app).get(`/api/shared-libraries/${shared.id}/items?limit=101`).set(auth(member.token))).status).toBe(400);
  expect((await request(app).get(`/api/shared-libraries/${shared.id}/items?q=Movie&type=series`).set(auth(member.token))).body.total).toBe(0);
  const source = await db.accountMedia.findFirstOrThrow({ where: { userId: owner.id } });
  await db.accountMedia.create({ data: { userId: owner.id, provider: source.provider, providerRef: "future-ref", credentialFingerprint: source.credentialFingerprint, name: "Future movie", type: "movie", phase: "finished" } });
  expect((await request(app).get(`/api/shared-libraries/${shared.id}/items`).set(auth(member.token))).body.total).toBe(3);
});
it("resolves a server-owned stream with no member credentials and persists no stream URL", async () => {
  const owner = await user("admin"), member = await user(), [film] = await imports(owner), shared = await library(owner);
  await grant(owner, shared.id, member);
  expect(await db.debridConfig.findUnique({ where: { userId: member.id } })).toBeNull();
  play.mockResolvedValueOnce({ selectionRequired: true, files: [{ token: "opaque-choice", name: "Film.mkv" }] }).mockResolvedValueOnce(stream);
  expect((await request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({})).body.selectionRequired).toBe(true);
  const response = await request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({ fileToken: "opaque-choice" });
  expect(response.status).toBe(200); expect(response.body.stream.url).toContain("temporary-stream.invalid");
  expect(play.mock.calls[1][1].apiKey).toBe("server-only-private-key"); expect(play.mock.calls[1][2]).toBe("private-film-ref"); expect(play.mock.calls[1][3]).toBe("opaque-choice");
  expect(JSON.stringify(await db.accountMedia.findMany())).not.toContain("temporary-stream.invalid");
  expect(await db.debridConfig.findUnique({ where: { userId: member.id } })).toBeNull();
});
it("revokes access to lookup and future playback immediately without removing imports", async () => {
  const owner = await user("admin"), member = await user(), [film] = await imports(owner), shared = await library(owner);
  await grant(owner, shared.id, member);
  expect((await request(app).delete(`/api/admin/shared-libraries/${shared.id}/users/${member.id}`).set(auth(owner.token))).status).toBe(200);
  expect((await request(app).get("/api/shared-libraries").set(auth(member.token))).body.libraries).toEqual([]);
  expect((await request(app).get(`/api/shared-libraries/${shared.id}/items/${film.id}`).set(auth(member.token))).status).toBe(404);
  expect((await request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({})).status).toBe(404);
  expect(play).not.toHaveBeenCalled(); expect(await db.accountMedia.count()).toBe(2);
});
it.each(["grant", "library", "source-key", "source-active", "source-role", "viewer-active", "viewer-version", "viewer-session", "provider"])("withholds a late signed URL after %s changes", async change => {
  const owner = await user("admin"), member = await user(), [film] = await imports(owner), shared = await library(owner);
  await grant(owner, shared.id, member);
  const result = deferred<AccountPlayResult>(); play.mockReturnValue(result.promise);
  const running = request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({}).then(value => value);
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
  if (change === "grant") await db.sharedLibraryGrant.deleteMany();
  if (change === "library") await db.sharedLibrary.update({ where: { id: shared.id }, data: { enabled: false } });
  if (change === "source-key") await db.debridConfig.update({ where: { userId: owner.id }, data: { realDebridToken: "rotated-private-account" } });
  if (change === "source-active") await db.user.update({ where: { id: owner.id }, data: { active: false } });
  if (change === "source-role") await db.user.update({ where: { id: owner.id }, data: { role: "user" } });
  if (change === "viewer-active") await db.user.update({ where: { id: member.id }, data: { active: false } });
  if (change === "viewer-version") await db.user.update({ where: { id: member.id }, data: { sessionVersion: { increment: 1 } } });
  if (change === "viewer-session") await request(app).post("/api/auth/logout").set(auth(member.token)).send({});
  if (change === "provider") await db.setting.upsert({ where: { key: "server" }, create: { key: "server", value: JSON.stringify({ disabledProviders: ["realdebrid"] }) }, update: { value: JSON.stringify({ disabledProviders: ["realdebrid"] }) } });
  result.resolve(stream);
  const response = await running;
  expect([401, 404, 409]).toContain(response.status); expect(JSON.stringify(response.body)).not.toMatch(/temporary-stream|never-persist|private-key|rotated-private/);
});
it("hides stale imports and unavailable source accounts from content and readiness", async () => {
  const owner = await user("admin"), member = await user(); await imports(owner);
  const first = await library(owner, "One", "all"), second = await library(owner, "Overlapping", "all");
  await grant(owner, first.id, member); await grant(owner, second.id, member);
  expect(await getSharedSetupState(member.id)).toEqual({ libraryCount: 2, readyCount: 2 });
  await db.debridConfig.update({ where: { userId: owner.id }, data: { realDebridToken: "new-account" } });
  expect((await request(app).get(`/api/shared-libraries/${first.id}/items`).set(auth(member.token))).body.total).toBe(0);
  expect(await getSharedSetupState(member.id)).toEqual({ libraryCount: 2, readyCount: 0 });
  await db.user.update({ where: { id: owner.id }, data: { active: false } });
  expect((await request(app).get("/api/shared-libraries").set(auth(member.token))).body.libraries).toEqual([]);
  expect(await getSharedSetupState(member.id)).toEqual({ libraryCount: 0, readyCount: 0 });
});
it("disables or deletes only the explicit share, leaving source items and provider account unchanged", async () => {
  const owner = await user("admin"), member = await user(); await imports(owner);
  const shared = await library(owner); await grant(owner, shared.id, member);
  expect((await request(app).patch(`/api/admin/shared-libraries/${shared.id}`).set(auth(owner.token)).send({ name: "Renamed", mediaType: "all", enabled: false })).status).toBe(200);
  expect((await request(app).get("/api/shared-libraries").set(auth(member.token))).body.libraries).toEqual([]);
  expect((await request(app).get("/api/admin/shared-libraries").set(auth(owner.token))).body.libraries[0]).toMatchObject({ name: "Renamed", enabled: false, itemCount: 2 });
  expect((await request(app).delete(`/api/admin/shared-libraries/${shared.id}`).set(auth(owner.token))).status).toBe(200);
  expect(await db.sharedLibraryGrant.count()).toBe(0); expect(await db.accountMedia.count()).toBe(2); expect(play).not.toHaveBeenCalled();
  expect((await db.debridConfig.findUniqueOrThrow({ where: { userId: owner.id } })).realDebridToken).toBe("server-only-private-key");
});

it("withholds details if the library media filter changes while metadata is being read", async () => {
  const owner = await user("admin"), member = await user(), [film] = await imports(owner), shared = await library(owner);
  await grant(owner, shared.id, member);
  const original = accountMetadata.decorateAccountMedia, started = deferred<void>(), release = deferred<void>();
  vi.spyOn(accountMetadata, "decorateAccountMedia").mockImplementationOnce(async items => { started.resolve(); await release.promise; return original(items); });
  const running = request(app).get(`/api/shared-libraries/${shared.id}/items/${film.id}`).set(auth(member.token)).then(value => value);
  await started.promise;
  await db.sharedLibrary.update({ where: { id: shared.id }, data: { mediaType: "series", updatedAt: new Date(Date.now() + 10) } });
  release.resolve();
  const response = await running;
  expect(response.status).toBe(409); expect(response.body.item).toBeUndefined(); expect(JSON.stringify(response.body)).not.toContain("Server Movie");
});

it.each(["list-key", "detail-key", "list-provider", "detail-provider"])("withholds %s metadata after source eligibility changes during decoration", async scenario => {
  const owner = await user("admin"), member = await user(), [film] = await imports(owner), shared = await library(owner);
  await grant(owner, shared.id, member);
  const original = accountMetadata.decorateAccountMedia, started = deferred<void>(), release = deferred<void>();
  vi.spyOn(accountMetadata, "decorateAccountMedia").mockImplementationOnce(async items => { started.resolve(); await release.promise; return original(items); });
  const path = `/api/shared-libraries/${shared.id}/items${scenario.startsWith("detail") ? `/${film.id}` : ""}`;
  const running = request(app).get(path).set(auth(member.token)).then(value => value);
  await started.promise;
  if (scenario.endsWith("key")) await db.debridConfig.update({ where: { userId: owner.id }, data: { realDebridToken: "rotated-during-decoration" } });
  else await db.setting.upsert({ where: { key: "server" }, create: { key: "server", value: JSON.stringify({ disabledProviders: ["realdebrid"] }) }, update: { value: JSON.stringify({ disabledProviders: ["realdebrid"] }) } });
  release.resolve();
  const response = await running;
  expect(response.status).toBe(409); expect(response.body.item).toBeUndefined(); expect(response.body.items).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toMatch(/Server Movie|private-film-ref|private-key|rotated-during/);
});

const keyed = { ...stream, mediaKey: "a".repeat(64) };
async function started() {
  const owner = await user("admin"), member = await user(), [film] = await imports(owner), shared = await library(owner);
  await grant(owner, shared.id, member);
  play.mockResolvedValue(keyed);
  const begin = await request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({});
  expect(begin.status).toBe(200);
  return { owner, member, film, shared, begin };
}
const progressUrl = (libraryId: string, itemId: string) => `/api/shared-libraries/${libraryId}/items/${itemId}/progress`;

it("saves per-viewer resume positions for shared imports and exposes them in Continue Watching", async () => {
  const { owner, member, film, shared, begin } = await started();
  expect(begin.body).toMatchObject({ resumeSeconds: 0 }); expect(begin.body.mediaKey).toBeUndefined();
  const put = (sequence: number, positionSeconds: number, token = member.token, sessionId = begin.body.progressSessionId) =>
    request(app).put(progressUrl(shared.id, film.id)).set(auth(token)).send({ sessionId, sequence, positionSeconds, durationSeconds: 1000 });
  expect((await put(1, 120)).body).toEqual({ accepted: true });
  expect((await put(1, 500)).body).toEqual({ accepted: false, reason: "out-of-order" });
  const list = await request(app).get("/api/shared-libraries/continue").set(auth(member.token));
  expect(list.body.items).toHaveLength(1);
  expect(list.body.items[0]).toMatchObject({ libraryId: shared.id, positionSeconds: 120, durationSeconds: 1000, item: { id: film.id } });
  expect(JSON.stringify(list.body)).not.toMatch(/temporary-stream|server-only-private-key|private-film-ref/);
  // The owner's own resume list and other viewers are unaffected.
  expect((await request(app).get("/api/shared-libraries/continue").set(auth(owner.token))).body.items).toEqual([]);
  const again = await request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({});
  expect(again.body.resumeSeconds).toBe(120); expect(again.body.durationSeconds).toBe(1000);
  // The previous player session is superseded; the new one may continue.
  expect((await put(2, 130)).status).toBe(404);
  expect((await put(1, 400, member.token, again.body.progressSessionId)).body.accepted).toBe(true);
  expect((await put(2, 990, member.token, again.body.progressSessionId)).body.accepted).toBe(true);
  expect((await request(app).get("/api/shared-libraries/continue").set(auth(member.token))).body.items).toEqual([]);
  expect((await request(app).post(playUrl(shared.id, film.id)).set(auth(member.token)).send({})).body.resumeSeconds).toBe(0);
});
it("rejects invalid, foreign and revoked shared progress and hides revoked items", async () => {
  const { owner, member, film, shared, begin } = await started(), other = await user();
  const body = { sessionId: begin.body.progressSessionId, sequence: 1, positionSeconds: 10, durationSeconds: 100 };
  expect((await request(app).put(progressUrl(shared.id, film.id)).send(body)).status).toBe(401);
  expect((await request(app).put(progressUrl(shared.id, film.id)).set(auth(member.token)).send({ ...body, positionSeconds: 500 })).status).toBe(400);
  expect((await request(app).put(progressUrl(shared.id, film.id)).set(auth(other.token)).send(body)).status).toBe(404);
  expect((await request(app).put(progressUrl(shared.id, film.id)).set(auth(member.token)).send({ ...body, sessionId: "unknown" })).status).toBe(404);
  expect((await request(app).put(progressUrl(shared.id, film.id)).set(auth(member.token)).send(body)).status).toBe(200);
  await request(app).delete(`/api/admin/shared-libraries/${shared.id}/users/${member.id}`).set(auth(owner.token));
  expect((await request(app).put(progressUrl(shared.id, film.id)).set(auth(member.token)).send({ ...body, sequence: 2 })).status).toBe(404);
  expect((await request(app).get("/api/shared-libraries/continue").set(auth(member.token))).body.items).toEqual([]);
  expect(await db.sharedLibraryProgress.count()).toBe(1);
  await db.user.delete({ where: { id: member.id } });
  expect(await db.sharedLibraryProgress.count()).toBe(0);
});

it("lets an administrator make a library visible to every active user without a per-user grant", async () => {
  const owner = await user("admin"), member = await user(), other = await user(), [film] = await imports(owner);
  const shared = await library(owner, "Movies", "movie");
  expect((await request(app).get("/api/shared-libraries").set(auth(member.token))).body.libraries).toEqual([]);
  const open = await request(app).patch(`/api/admin/shared-libraries/${shared.id}`).set(auth(owner.token)).send({ everyone: true });
  expect(open.status).toBe(200); expect(open.body.library).toMatchObject({ everyone: true, users: [] });
  for (const viewer of [member, other]) {
    const seen = await request(app).get("/api/shared-libraries").set(auth(viewer.token));
    expect(seen.body.libraries.map((entry: { id: string }) => entry.id)).toEqual([shared.id]);
    const items = await request(app).get(`/api/shared-libraries/${shared.id}/items`).set(auth(viewer.token));
    expect(items.status).toBe(200); expect(items.body.items.map((entry: { id: string }) => entry.id)).toEqual([film.id]);
  }
  // Pausing the library hides it from everyone; closing it again returns to explicit grants only.
  await request(app).patch(`/api/admin/shared-libraries/${shared.id}`).set(auth(owner.token)).send({ enabled: false });
  expect((await request(app).get("/api/shared-libraries").set(auth(member.token))).body.libraries).toEqual([]);
  await request(app).patch(`/api/admin/shared-libraries/${shared.id}`).set(auth(owner.token)).send({ enabled: true, everyone: false });
  expect((await request(app).get("/api/shared-libraries").set(auth(member.token))).body.libraries).toEqual([]);
  await grant(owner, shared.id, member);
  expect((await request(app).get("/api/shared-libraries").set(auth(member.token))).body.libraries).toHaveLength(1);
  expect((await request(app).get("/api/shared-libraries").set(auth(other.token))).body.libraries).toEqual([]);
  const created = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "TV Shows", mediaType: "series", everyone: true });
  expect(created.status).toBe(201); expect(created.body.library.everyone).toBe(true);
});
