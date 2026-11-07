import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { cancelAccountScan, queueAccountScans, runAccountLibraryJob, setAccountImportHook } from "../src/account-library";
import { playAccountItem, scanAccountPage } from "../src/providers/account-library";
import { ProviderError } from "../src/providers/types";
vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const scan = vi.mocked(scanAccountPage), play = vi.mocked(playAccountItem);
let serial = 0;
async function owner(role: "user" | "admin" = "user") {
  const user = await db.user.create({ data: { email: `account-library-${serial++}@example.invalid`, displayName: "Library owner", hashedPassword: "fixture-no-password-auth", role } });
  return { ...user, token: signSession({ sub: user.id, email: user.email, role, version: user.sessionVersion }) };
}
async function configure(userId: string, apiKey = "private-fixture-key", automatic = true) {
  await db.debridConfig.create({ data: { userId, realDebridToken: apiKey, autoImportLibrary: automatic } });
}
const item = (ref = "existing-ref", name = "Example.Movie.2020.mkv") => ({ providerRef: ref, name, phase: "finished" as const, progress: 100 });
async function importOne(userId: string) {
  await configure(userId); scan.mockResolvedValue({ items: [item()], nextCursor: null });
  await queueAccountScans(userId); await runAccountLibraryJob(); return db.accountMedia.findFirstOrThrow({ where: { userId } });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); setAccountImportHook(null); });
afterEach(() => { setAccountImportHook(null); vi.restoreAllMocks(); });

it("queues saved credentials locally and keeps scans/setup GET private and free of provider traffic", async () => {
  const user = await owner(); const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider traffic"));
  const saved = await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "never-return-this-private-key", autoImportLibrary: true });
  expect(saved.status).toBe(200); expect(scan).not.toHaveBeenCalled();
  const status = await request(app).get("/api/account/library/scans").set(auth(user.token));
  expect(status.status).toBe(200); expect(status.headers["cache-control"]).toContain("no-store");
  expect(status.body.automatic).toBe(true); expect(status.body.providers.find((row: { provider: string }) => row.provider === "realdebrid").status).toBe("queued");
  const setup = await request(app).get("/api/account/setup").set(auth(user.token));
  expect(setup.status).toBe(200); expect(setup.body.accountLibrary.totalImported).toBe(0); expect(setup.body.connectionVerified).toBe(false);
  expect(JSON.stringify(status.body)).not.toMatch(/never-return|credentialFingerprint|providerRef|cursor/); expect(fetch).not.toHaveBeenCalled();
  expect((await request(app).get("/api/account/library")).status).toBe(401);
});
it("walks durable pages including empty pages and imports duplicate refs idempotently without shared catalog writes", async () => {
  const user = await owner(); await configure(user.id);
  scan.mockResolvedValueOnce({ items: [item("a")], nextCursor: "page-two" }).mockResolvedValueOnce({ items: [], nextCursor: "page-three" }).mockResolvedValueOnce({ items: [item("a"), item("b", "Example.Show.S02E03.mkv")], nextCursor: null });
  expect((await queueAccountScans(user.id)).queued).toBe(1); await runAccountLibraryJob();
  expect((await db.accountScan.findFirstOrThrow()).cursor).toBe("page-two"); expect(await db.accountMedia.count()).toBe(1);
  await runAccountLibraryJob(); await runAccountLibraryJob();
  expect(scan.mock.calls[1][2]).toBe("page-two"); expect(scan.mock.calls[2][2]).toBe("page-three");
  const status = await db.accountScan.findFirstOrThrow(); expect(status).toMatchObject({ status: "complete", pages: 3, scanned: 3, imported: 2, skipped: 1 });
  const media = await db.accountMedia.findMany({ orderBy: { name: "asc" } }); expect(media).toHaveLength(2); expect(media[0]).toMatchObject({ name: "Example Movie", year: 2020, type: "movie" }); expect(media[1].type).toBe("series");
  const catalog = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE name='Title'");
  if (catalog.length) expect(Number((await db.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM Title"))[0].count)).toBe(0);
});
it("a repeated onboarding start does not restart complete scans and a forced rescan never duplicates imports", async () => {
  const user = await owner(); await importOne(user.id);
  expect((await queueAccountScans(user.id)).queued).toBe(0); expect((await queueAccountScans(user.id, { force: true, automatic: false })).queued).toBe(1);
  expect((await queueAccountScans(user.id, { force: true, automatic: false })).queued).toBe(0);
  await runAccountLibraryJob(); expect(await db.accountMedia.count()).toBe(1);
  expect(await db.accountScan.findFirstOrThrow()).toMatchObject({ status: "complete", imported: 0, skipped: 1 });
});
it("keeps one user's imports and refs out of every other user's library including administrators", async () => {
  const user = await owner(), admin = await owner("admin"); const imported = await importOne(user.id);
  const own = await request(app).get("/api/account/library").set(auth(user.token)); expect(own.status).toBe(200); expect(own.body.total).toBe(1); expect(own.body.items[0].name).toBe("Example Movie");
  expect(JSON.stringify(own.body)).not.toMatch(/providerRef|credentialFingerprint|existing-ref|private-fixture-key|userId/);
  expect((await request(app).get("/api/account/library").set(auth(admin.token))).body.total).toBe(0);
  for (const method of ["get", "delete"] as const) expect((await request(app)[method](`/api/account/library/${imported.id}`).set(auth(admin.token))).status).toBe(404);
  expect((await request(app).post(`/api/account/library/${imported.id}/play`).set(auth(admin.token)).send({})).status).toBe(404); expect(play).not.toHaveBeenCalled();
});
it("binds bounded pagination cursors to owner and search filters", async () => {
  const user = await owner(), other = await owner();
  for (let index = 0; index < 3; index++) await db.accountMedia.create({ data: { userId: user.id, provider: "realdebrid", providerRef: `private-${index}`, credentialFingerprint: "private", name: `Film ${index}`, type: index === 2 ? "series" : "movie", phase: "finished" } });
  const first = await request(app).get("/api/account/library?limit=1&q=Film").set(auth(user.token)); expect(first.status).toBe(200); expect(first.body.items).toHaveLength(1); expect(first.body.nextCursor).toBeTruthy();
  const second = await request(app).get("/api/account/library").query({ limit: 1, q: "Film", cursor: first.body.nextCursor }).set(auth(user.token)); expect(second.status).toBe(200); expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  expect((await request(app).get("/api/account/library").query({ q: "changed", cursor: first.body.nextCursor }).set(auth(user.token))).status).toBe(400);
  expect((await request(app).get("/api/account/library").query({ q: "Film", cursor: first.body.nextCursor }).set(auth(other.token))).status).toBe(400);
  expect((await request(app).get("/api/account/library?limit=101").set(auth(user.token))).status).toBe(400);
  const series = await request(app).get("/api/account/library?type=series").set(auth(user.token)); expect(series.body.total).toBe(1);
});
it("cancels an in-flight page without committing late imports or restarting on onboarding", async () => {
  const user = await owner(); await configure(user.id); const page = deferred<{ items: ReturnType<typeof item>[]; nextCursor: null }>(); scan.mockReturnValue(page.promise);
  await queueAccountScans(user.id); const running = runAccountLibraryJob(); await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
  await cancelAccountScan(user.id, "realdebrid"); page.resolve({ items: [item()], nextCursor: null }); await running;
  expect(await db.accountMedia.count()).toBe(0); expect((await db.accountScan.findFirstOrThrow()).status).toBe("cancelled"); expect((await queueAccountScans(user.id)).queued).toBe(0);
});
it("invalidates an in-flight claim when credentials change and processes only the new account", async () => {
  const user = await owner(); await configure(user.id, "old-private-key"); const page = deferred<{ items: ReturnType<typeof item>[]; nextCursor: null }>();
  scan.mockReturnValueOnce(page.promise).mockResolvedValueOnce({ items: [item("new-account-item")], nextCursor: null });
  await queueAccountScans(user.id); const running = runAccountLibraryJob(); await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
  expect((await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "new-private-key" })).status).toBe(200);
  page.resolve({ items: [item("old-account-item")], nextCursor: null }); await running; expect(await db.accountMedia.count()).toBe(0);
  await runAccountLibraryJob(); expect(scan.mock.calls[1][1].apiKey).toBe("new-private-key"); expect((await db.accountMedia.findFirstOrThrow()).providerRef).toBe("new-account-item");
  expect(JSON.stringify(await db.accountScan.findFirstOrThrow())).not.toMatch(/old-private-key|new-private-key/);
});
it("honors automatic import opt-out and permits a deliberate manual rescan", async () => {
  const user = await owner(); await configure(user.id, "private-key", false); scan.mockResolvedValue({ items: [item()], nextCursor: null });
  expect((await queueAccountScans(user.id)).queued).toBe(0); expect(await runAccountLibraryJob()).toBe(false); expect(scan).not.toHaveBeenCalled();
  expect((await request(app).post("/api/account/library/scan").set(auth(user.token)).send({ force: false })).body.queued).toBe(0);
  expect((await request(app).post("/api/account/library/scan").set(auth(user.token)).send({ force: true })).body.queued).toBe(1);
  await runAccountLibraryJob(); expect(await db.accountMedia.count()).toBe(1);
});
it("stops automatic in-flight results when the preference is disabled", async () => {
  const user = await owner(); await configure(user.id); const page = deferred<{ items: ReturnType<typeof item>[]; nextCursor: null }>(); scan.mockReturnValue(page.promise);
  await queueAccountScans(user.id); const running = runAccountLibraryJob(); await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
  expect((await request(app).put("/api/account/debrid").set(auth(user.token)).send({ autoImportLibrary: false })).status).toBe(200);
  page.resolve({ items: [item()], nextCursor: null }); await running; expect(await db.accountMedia.count()).toBe(0); expect((await db.accountScan.findFirstOrThrow()).status).toBe("cancelled");
});
it("does not contact globally disabled providers or providers disabled in settings", async () => {
  const user = await owner(); await configure(user.id); await queueAccountScans(user.id);
  await db.setting.create({ data: { key: "server", value: JSON.stringify({ disabledProviders: ["realdebrid"] }) } });
  await runAccountLibraryJob(); expect(scan).not.toHaveBeenCalled(); expect((await db.accountScan.findFirstOrThrow()).status).toBe("cancelled");
  await db.setting.deleteMany(); await db.setting.create({ data: { key: "providers", value: JSON.stringify({ realdebrid: { enabled: false } }) } });
  expect((await queueAccountScans(user.id, { force: true })).queued).toBe(0);
});
it("keeps earlier pages through bounded failures and backoff without leaking upstream errors", async () => {
  const user = await owner(); await configure(user.id);
  scan.mockResolvedValueOnce({ items: [item()], nextCursor: "next-page" }).mockRejectedValue(new ProviderError("realdebrid", "secret-key https://private.invalid/?apikey=secret", 503));
  await queueAccountScans(user.id); await runAccountLibraryJob(); await runAccountLibraryJob();
  expect(await runAccountLibraryJob()).toBe(false);
  for (let attempt = 0; attempt < 2; attempt++) { await db.accountScan.updateMany({ data: { nextAttemptAt: new Date(0) } }); await runAccountLibraryJob(); }
  expect(scan).toHaveBeenCalledTimes(4); expect(await db.accountMedia.count()).toBe(1); const state = await db.accountScan.findFirstOrThrow(); expect(state).toMatchObject({ status: "error", failures: 3, imported: 1 });
  expect(state.error).not.toMatch(/secret-key|private.invalid|apikey/);
});
it("recovers expired leases while respecting a live competing lease", async () => {
  const user = await owner(); await configure(user.id); scan.mockResolvedValue({ items: [item()], nextCursor: null }); await queueAccountScans(user.id);
  await db.accountScan.updateMany({ data: { status: "scanning", leaseUntil: new Date(Date.now() + 60000) } });
  expect(await runAccountLibraryJob()).toBe(false); expect(scan).not.toHaveBeenCalled();
  await db.accountScan.updateMany({ data: { leaseUntil: new Date(0) } }); expect(await runAccountLibraryJob()).toBe(true); expect(await db.accountMedia.count()).toBe(1);
});
it("returns pending/file-choice/play responses only for explicit owner requests without storing signed URLs", async () => {
  const user = await owner(); const imported = await importOne(user.id);
  play.mockResolvedValueOnce({ pending: true, progress: 40 }).mockResolvedValueOnce({ selectionRequired: true, files: [{ token: "opaque-video-token", name: "Movie.mkv", size: 123 }] }).mockResolvedValueOnce({ stream: { provider: "realdebrid", url: "https://stream.example.invalid/video?token=signed-secret", filename: "Movie.mkv" } });
  const pending = await request(app).post(`/api/account/library/${imported.id}/play`).set(auth(user.token)).send({}); expect(pending.status).toBe(200); expect(pending.body.pending).toBe(true);
  const choice = await request(app).post(`/api/account/library/${imported.id}/play`).set(auth(user.token)).send({}); expect(choice.status).toBe(200); expect(choice.body.selectionRequired).toBe(true);
  const stream = await request(app).post(`/api/account/library/${imported.id}/play`).set(auth(user.token)).send({ fileToken: "opaque-video-token" }); expect(stream.status).toBe(200); expect(stream.body.stream.filename).toBe("Movie.mkv"); expect(play.mock.calls[2][3]).toBe("opaque-video-token");
  expect(JSON.stringify(await db.accountMedia.findFirstOrThrow())).not.toMatch(/signed-secret|stream.example|apiKey/);
});
it("does not resolve old provider refs against a newly connected account", async () => {
  const user = await owner(); const imported = await importOne(user.id);
  await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "different-account-key" });
  const response = await request(app).post(`/api/account/library/${imported.id}/play`).set(auth(user.token)).send({}); expect(response.status).toBe(409); expect(play).not.toHaveBeenCalled();
});
it("removes only local owned imports and metadata, while account deletion cascades private scan state", async () => {
  const user = await owner(); const imported = await importOne(user.id); const other = await owner();
  await db.metadataRecord.create({ data: { targetType: "account", targetId: imported.id, ownerId: user.id, name: imported.name, mediaType: "movie" } });
  expect((await request(app).delete(`/api/account/library/${imported.id}`).set(auth(other.token))).status).toBe(404);
  expect((await request(app).delete(`/api/account/library/${imported.id}`).set(auth(user.token))).status).toBe(200);
  expect(await db.metadataRecord.count()).toBe(0); expect(await db.accountMedia.count()).toBe(0); expect(play).not.toHaveBeenCalled();
  await db.metadataRecord.create({ data: { targetType: "account", targetId: "orphan-safe", ownerId: user.id, name: "Private", mediaType: "movie" } });
  await db.user.delete({ where: { id: user.id } }); expect(await db.accountScan.count()).toBe(0); expect(await db.metadataRecord.count()).toBe(0);
});
it("invokes metadata enqueue only after a durable import and keeps the scan successful if enqueue fails", async () => {
  const user = await owner(); await configure(user.id); scan.mockResolvedValue({ items: [item()], nextCursor: null });
  const hook = vi.fn(async (items: Array<{ userId: string }>) => { expect(await db.accountMedia.count()).toBe(1); expect(items[0].userId).toBe(user.id); throw new Error("temporary metadata configuration issue"); });
  setAccountImportHook(hook); await queueAccountScans(user.id); await runAccountLibraryJob(); expect(hook).toHaveBeenCalledOnce(); expect((await db.accountScan.findFirstOrThrow()).status).toBe("complete");
});

it("preserves confirmed names, years and metadata locks through same-account rescans", async () => {
  const user = await owner(); const imported = await importOne(user.id);
  await db.accountMedia.update({ where: { id: imported.id }, data: { name: "Confirmed title", type: "series", year: 1999 } });
  const record = await db.metadataRecord.create({ data: { targetType: "account", targetId: imported.id, ownerId: user.id, name: "Confirmed title", mediaType: "series", year: 1999, lockedFields: '["name","year"]', status: "matched" } });
  scan.mockResolvedValue({ items: [item("existing-ref", "Provider.Release.Name.2024.mkv")], nextCursor: null });
  await queueAccountScans(user.id, { force: true, automatic: false }); await runAccountLibraryJob();
  expect(await db.accountMedia.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ name: "Confirmed title", type: "series", year: 1999 });
  expect(await db.metadataRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({ lockedFields: '["name","year"]', status: "matched" });
  const setup = await request(app).get("/api/account/setup").set(auth(user.token));
  const check = setup.body.checks.find((row: { id: string }) => row.id === "catalog");
  if (check) { expect(check.status).toBe("complete"); expect(check.href).toBe("/library"); }
});
it("discards in-flight results when the owner is deactivated", async () => {
  const user = await owner(); await configure(user.id); const page = deferred<{ items: ReturnType<typeof item>[]; nextCursor: null }>(); scan.mockReturnValue(page.promise);
  await queueAccountScans(user.id); const running = runAccountLibraryJob(); await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
  await db.user.update({ where: { id: user.id }, data: { active: false } }); page.resolve({ items: [item()], nextCursor: null }); await running;
  expect(await db.accountMedia.count()).toBe(0); expect((await db.accountScan.findFirstOrThrow()).status).toBe("cancelled");
});
it("stops rejected credentials without retrying and sanitizes the failure", async () => {
  const user = await owner(); await configure(user.id); scan.mockRejectedValue(new ProviderError("realdebrid", "private-fixture-key denied", 401));
  await queueAccountScans(user.id); await runAccountLibraryJob(); expect((await db.accountScan.findFirstOrThrow()).status).toBe("error"); expect(await runAccountLibraryJob()).toBe(false);
  expect((await db.accountScan.findFirstOrThrow()).error).not.toContain("private-fixture-key"); expect(scan).toHaveBeenCalledOnce();
});
it("withholds a signed playback response after credentials change during resolution", async () => {
  const user = await owner(); const imported = await importOne(user.id);
  const result = deferred<{ stream: { provider: "realdebrid"; url: string; filename: string } }>(); play.mockReturnValue(result.promise);
  const response = request(app).post(`/api/account/library/${imported.id}/play`).set(auth(user.token)).send({}).then(value => value);
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
  await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "rotated-account-key" });
  result.resolve({ stream: { provider: "realdebrid", url: "https://private-stream.invalid/?secret=signed", filename: "Movie.mkv" } });
  const value = await response; expect(value.status).toBe(409); expect(JSON.stringify(value.body)).not.toContain("private-stream.invalid");
});

it.each([400, 404, 409, 422])("keeps recoverable playback status %s without exposing provider errors", async status => {
  const user = await owner(); const imported = await importOne(user.id); play.mockRejectedValue(new ProviderError("realdebrid", "private-raw-provider https://secret.invalid", status));
  const response = await request(app).post(`/api/account/library/${imported.id}/play`).set(auth(user.token)).send({}); expect(response.status).toBe(status); expect(JSON.stringify(response.body)).not.toMatch(/private-raw-provider|secret.invalid/);
});

it("counts only own finished imports with a current enabled credential binding toward setup content readiness", async () => {
  const user = await owner(), other = await owner(); const imported = await importOne(user.id);
  const check = async (token: string) => {
    const response = await request(app).get("/api/account/setup").set(auth(token)); expect(response.status).toBe(200);
    if (response.body.product === "streamrd") expect(response.body.catalog.available).toBe(false); else expect(response.body.indexers.configured).toBe(false);
    return response.body.checks.find((row: { id: string }) => row.id === "catalog" || row.id === "indexers");
  };
  expect(await check(user.token)).toMatchObject({ status: "complete", href: "/library" });
  expect((await check(other.token)).status).toBe("action");
  await db.accountMedia.update({ where: { id: imported.id }, data: { phase: "downloading", progress: 40 } });
  expect((await check(user.token)).status).toBe("action");
  await db.accountMedia.update({ where: { id: imported.id }, data: { phase: "finished", progress: 100 } });
  await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "new-account-binding" });
  await db.accountMedia.update({ where: { id: imported.id }, data: { phase: "finished", progress: 100 } });
  expect((await check(user.token)).status).toBe("action");
  await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "private-fixture-key" });
  expect((await check(user.token)).status).toBe("complete");
  await db.setting.upsert({ where: { key: "server" }, create: { key: "server", value: '{"disabledProviders":["realdebrid"]}' }, update: { value: '{"disabledProviders":["realdebrid"]}' } });
  expect((await check(user.token)).status).toBe("action");
});

it("skips identifiable non-video account files rather than inventing movie titles", async () => {
  const user = await owner(); await configure(user.id);
  scan.mockResolvedValue({ items: [item("notes", "readme.nfo"), item("subtitles", "Film.2020.srt"), item("movie", "Film.2020.mp4")], nextCursor: null });
  await queueAccountScans(user.id); await runAccountLibraryJob();
  expect(await db.accountMedia.count()).toBe(1);
  expect(await db.accountScan.findFirstOrThrow()).toMatchObject({ status: "complete", scanned: 3, imported: 1, skipped: 2 });
});
