import { createServer, Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, adminAndUser } from "./helpers";
import { db } from "../src/db";
import { recordUpdateOutcome, recordUpdateOutcomeWhenKnown, redact } from "../src/routes/logs";

beforeEach(async () => { await resetDb(); });
const base = Date.parse("2026-02-01T00:00:00Z"), at = (seconds: number) => new Date(base + seconds * 1000);
/** A request that was approved and then failed, between ordinary log lines. */
async function seed() {
  await db.logEvent.deleteMany();
  const wanted = await db.mediaRequest.create({ data: { canonicalKey: "tmdb:movie:1", provider: "tmdb", externalId: "1", mediaType: "movie", name: "A Quiet Harbour", year: 2019, metadata: "{}", status: "failed", providerId: "realdebrid", destination: "cloud", error: "The provider refused the transfer." } });
  await db.requestEvent.createMany({ data: [
    { requestId: wanted.id, status: "requested", message: "Request received. Waiting for administrator approval.", createdAt: at(10) },
    { requestId: wanted.id, status: "approved", message: "Administrator approved a selected release for cloud download.", createdAt: at(30) },
    { requestId: wanted.id, status: "failed", message: "The provider refused the transfer.", createdAt: at(50) },
  ] });
  await db.logEvent.createMany({ data: [
    { level: "info", type: "login", message: "Signed in", userId: "u1", createdAt: at(0) },
    { level: "info", type: "playback", message: "Played something", createdAt: at(20) },
    { level: "warn", type: "provider_error", message: "Provider was slow", provider: "realdebrid", createdAt: at(40) },
    { level: "info", type: "system", message: "Housekeeping", meta: JSON.stringify({ libraryId: "lib-77" }), createdAt: at(60) },
  ] });
  return wanted;
}

it("shows every step of a request in the log, in order with everything else, and pages through the joined stream exactly once", async () => {
  const { admin, user } = await adminAndUser(); const wanted = await seed();
  const all = await request(app).get("/api/admin/logs").set(auth(admin.token));
  expect(all.status).toBe(200);
  expect(all.body.logs.map((row: { type: string }) => row.type)).toEqual(["system", "request", "provider_error", "request", "playback", "request", "login"]);
  const failed = all.body.logs[1];
  expect(failed).toMatchObject({ type: "request", level: "error", provider: "realdebrid", message: "A Quiet Harbour (2019): The provider refused the transfer." });
  expect(JSON.parse(failed.meta)).toMatchObject({ requestId: wanted.id, status: "failed", destination: "cloud" });
  const seen: string[] = []; let cursor: string | null = null, pages = 0;
  do {
    const response: request.Response = await request(app).get("/api/admin/logs").query({ limit: 2, ...(cursor ? { cursor } : {}) }).set(auth(admin.token));
    seen.push(...response.body.logs.map((row: { id: string }) => row.id)); cursor = response.body.nextCursor; pages++;
  } while (cursor && pages < 10);
  expect(pages).toBe(4); expect(seen).toEqual(all.body.logs.map((row: { id: string }) => row.id));
  expect((await request(app).get("/api/admin/logs").set(auth(user.token))).status).toBe(403);
});

it("finds a request's whole history by its title or its id, and filters request steps like any other line", async () => {
  const { admin } = await adminAndUser(); const wanted = await seed();
  const get = async (query: Record<string, string>) => (await request(app).get("/api/admin/logs").query(query).set(auth(admin.token))).body.logs as Array<{ type: string; level: string; message: string }>;
  expect((await get({ q: "quiet harbour" })).length).toBe(3);
  expect((await get({ q: wanted.id })).map(row => row.type)).toEqual(["request", "request", "request"]);
  expect((await get({ type: "request" })).length).toBe(3);
  expect((await get({ type: "playback" })).map(row => row.type)).toEqual(["playback"]);
  expect((await get({ level: "error" })).map(row => row.message)).toEqual(["A Quiet Harbour (2019): The provider refused the transfer."]);
  expect((await get({ level: "info" })).map(row => row.type)).toEqual(["system", "request", "playback", "request", "login"]);
  expect((await get({ provider: "realdebrid" })).length).toBe(4);
  expect((await get({ userId: "u1" })).map(row => row.type)).toEqual(["login"]);              // request steps record no acting account
  expect((await get({ q: "lib-77" })).map(row => row.type)).toEqual(["system"]);              // details are searched too
  expect((await get({ from: at(25).toISOString(), to: at(45).toISOString() })).map(row => row.type)).toEqual(["provider_error", "request"]);
  const exported = await request(app).get("/api/admin/logs/export").query({ format: "txt", type: "request" }).set(auth(admin.token));
  expect(exported.text.trim().split("\n").length).toBe(3); expect(exported.text).toContain("ERROR request [realdebrid] A Quiet Harbour (2019)");
});

it("removes links, magnets, addresses and anything key-shaped", () => {
  const out = redact("GET https://user:pw@download.example.com/dl/AbC123?token=zzz failed for someone@example.org; magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x apikey=abcd1234 Authorization: Bearer eyJhbGciOi.payload key 0123456789abcdef0123456789abcdef0123");
  for (const secret of ["user:pw", "AbC123", "zzz", "someone@example.org", "btih", "abcd1234", "eyJhbGciOi", "0123456789abcdef0123456789abcdef0123"]) expect(out).not.toContain(secret);
  expect(out).toContain("https://download.example.com/<…>");
  expect(redact("The provider token was rejected for clx0abcdefghijklmnopqrstuv")).toBe("The provider token was rejected for clx0abcdefghijklmnopqrstuv");   // plain words and record ids stay readable
});

it("builds a diagnostic bundle for administrators with the stuck requests and recent log, and nothing secret in it", async () => {
  const { admin, user } = await adminAndUser(); const wanted = await seed();
  await db.requestEvent.updateMany({ data: { createdAt: new Date() } }); await db.logEvent.updateMany({ data: { createdAt: new Date() } });
  await db.logEvent.create({ data: { level: "error", type: "provider_error", message: "Fetch failed for https://api.example.net/unrestrict?apikey=SUPERSECRETKEY123 (owner@example.org)", meta: JSON.stringify({ magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", header: "Authorization: Bearer abc.def.ghi" }) } });
  expect((await request(app).get("/api/admin/logs/bundle").set(auth(user.token))).status).toBe(403);
  const response = await request(app).get("/api/admin/logs/bundle").query({ days: 3 }).set(auth(admin.token));
  expect(response.status).toBe(200); expect(response.headers["content-disposition"]).toMatch(/-diagnostics-.*\.json"/); expect(response.headers["cache-control"]).toContain("no-store");
  const bundle = response.body;
  expect(bundle).toMatchObject({ days: 3, accounts: { users: 2, admins: 1 }, requestCounts: { failed: 1 } });
  expect(bundle.version).toMatch(/^\d+\.\d+\.\d+$/); expect(bundle.runtime.node).toBe(process.version);
  expect(bundle.requestsNeedingAttention).toHaveLength(1);
  expect(bundle.requestsNeedingAttention[0]).toMatchObject({ id: wanted.id, name: "A Quiet Harbour", status: "failed" }); expect(bundle.requestsNeedingAttention[0].events).toHaveLength(3);
  expect(bundle.logs.length).toBeGreaterThanOrEqual(8);
  expect(bundle.logs.some((row: { message: string }) => row.message.includes("https://api.example.net/<…>"))).toBe(true);
  for (const secret of ["SUPERSECRETKEY123", "owner@example.org", "btih", "abc.def.ghi", admin.email ?? "admin@", process.env.JWT_SECRET ?? "\u0000"]) expect(response.text).not.toContain(secret);
  expect(await db.logEvent.count({ where: { type: "admin_action", message: "Downloaded a diagnostic bundle" } })).toBe(1);
});

it("records failed sign-ins, so repeated guesses can be seen", async () => {
  const { admin } = await adminAndUser(); await db.logEvent.deleteMany();
  expect((await request(app).post("/api/auth/login").send({ email: admin.email, password: "not-the-password" })).status).toBe(401);
  expect((await request(app).post("/api/auth/login").send({ email: "nobody@example.invalid", password: "whatever-1" })).status).toBe(401);
  await new Promise(done => setTimeout(done, 100));
  const lines = await db.logEvent.findMany({ where: { type: "login", level: "warn" }, orderBy: { createdAt: "asc" } });
  expect(lines.map(line => line.message)).toEqual([`Failed sign-in for ${admin.email}`, "Failed sign-in for nobody@example.invalid"]);
  expect(lines[0].userId).toBe(admin.id); expect(lines[1].userId).toBeNull(); expect(JSON.stringify(lines)).not.toMatch(/not-the-password|whatever-1/);
});

let helper: Server | undefined;
afterEach(async () => { delete process.env.MEDIA_MANAGER_URL; delete process.env.MEDIA_MANAGER_TOKEN; if (helper) { await new Promise(done => helper!.close(done)); helper = undefined; } });
it("copies the update helper's account of the last update into the log once, and marks a rollback as an error", async () => {
  let state = { state: "done", error: "", startedAt: "2026-02-01T10:00:00.000Z", finishedAt: "2026-02-01T10:02:00.000Z", log: [{ time: "2026-02-01T10:00:01.000Z", message: "Stopping StreamRD (it is back in a minute)" }, { time: "2026-02-01T10:01:50.000Z", message: "Updated." }] };
  let asked = "";
  helper = createServer((req, res) => { asked = `${req.method} ${req.url} ${req.headers.authorization}`; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(state)); });
  await new Promise<void>(done => helper!.listen(0, "127.0.0.1", done));
  expect(await recordUpdateOutcome()).toBe(false);                                   // no helper set up: nothing to record
  process.env.MEDIA_MANAGER_URL = `http://127.0.0.1:${(helper.address() as { port: number }).port}`; process.env.MEDIA_MANAGER_TOKEN = "t".repeat(32);
  await db.logEvent.deleteMany();
  expect(await recordUpdateOutcome()).toBe(true); expect(asked).toBe(`GET /update Bearer ${"t".repeat(32)}`);
  expect(await recordUpdateOutcome()).toBe(false);                                   // the same update is not recorded twice
  const first = await db.logEvent.findMany({ where: { type: "system" } });
  expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ level: "info" }); expect(first[0].message).toMatch(/^Update finished; now running \d+\.\d+\.\d+\.$/);
  expect(JSON.parse(first[0].meta!).update.steps).toHaveLength(2);
  state = { ...state, state: "failed", error: "The new version did not become healthy", finishedAt: "2026-02-02T10:02:00.000Z" };
  expect(await recordUpdateOutcome()).toBe(true);
  const rolledBack = await db.logEvent.findFirst({ where: { type: "system", level: "error" } });
  expect(rolledBack?.message).toMatch(/Update failed and the previous version was put back .*did not become healthy/);
  state = { ...state, state: "running", finishedAt: null as unknown as string };
  expect(await recordUpdateOutcome()).toBe("pending");                               // an update still in progress is left alone, and said to be
  const before = await db.logEvent.count({ where: { type: "system" } });
  // The new container starts while its update is still being confirmed healthy: the outcome is recorded as soon as it is known.
  recordUpdateOutcomeWhenKnown(20, 50);
  await new Promise(done => setTimeout(done, 80)); expect(await db.logEvent.count({ where: { type: "system" } })).toBe(before);
  state = { ...state, state: "done", finishedAt: "2026-02-03T10:00:00.000Z" };
  for (let i = 0; i < 100 && (await db.logEvent.count({ where: { type: "system" } })) === before; i++) await new Promise(done => setTimeout(done, 20));
  expect(await db.logEvent.count({ where: { type: "system" } })).toBe(before + 1);
});
