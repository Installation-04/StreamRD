import http from "node:http";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { adminAndUser, app, auth, resetDb, TestUser } from "./helpers";
import { db } from "../src/db";

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
async function serve(handler: (request: Seen) => { status?: number; json?: unknown }): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { const entry = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") }; seen.push(entry); const answer = handler(entry); response.writeHead(answer.status ?? 200, { "Content-Type": "application/json" }); response.end(answer.json === undefined ? "" : JSON.stringify(answer.json)); });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>(done => server.close(() => done())) };
}
const TOKEN = "m".repeat(40);
let admin: TestUser, member: TestUser; const closers: Array<() => Promise<void>> = [];
const keep = async <T extends { close: () => Promise<void> }>(promise: Promise<T>) => { const value = await promise; closers.push(value.close); return value; };
const saved = { ...process.env };
beforeEach(async () => { await resetDb(); ({ admin, user: member } = await adminAndUser()); for (const key of ["MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN", "PLEX_URL", "JELLYFIN_URL"]) delete process.env[key]; });
afterEach(async () => { for (const close of closers.splice(0)) await close(); process.env = { ...saved }; });
const get = () => request(app).get("/api/admin/media-servers").set(auth(admin.token));

it("is for the administrator only", async () => {
  expect((await request(app).get("/api/admin/media-servers")).status).toBe(401);
  for (const [method, path] of [["get", ""], ["put", ""], ["post", "/plex/launch"], ["post", "/plex/stop"], ["delete", "/plex"], ["post", "/plex/test"], ["post", "/plex/refresh"]] as const) expect((await request(app)[method](`/api/admin/media-servers${path}`).set(auth(member.token)).send({})).status, `${method} ${path}`).toBe(403);
  expect((await request(app).post("/api/admin/media-servers/portainer/launch").set(auth(admin.token)).send({})).status).toBe(404);
});

it("shows the defaults and explains that launching needs the media manager when it is not installed", async () => {
  const view = await get(); expect(view.status).toBe(200);
  expect(view.body).toEqual({ manager: { available: false }, servers: { jellyfin: { port: 8096, state: "unknown", secretHint: null }, plex: { port: 32400, state: "unknown", secretHint: null } } });
  const launch = await request(app).post("/api/admin/media-servers/plex/launch").set(auth(admin.token)).send({});
  expect(launch.status).toBe(409); expect(launch.body.error).toMatch(/media manager/i);
});

it("keeps ports and tokens, storing the tokens encrypted and never sending them back", async () => {
  const response = await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ plex: { port: 32401, secret: "plex-token-abcd1234" }, jellyfin: { secret: "jellyfin-key-wxyz9876" } });
  expect(response.status).toBe(200); expect(response.body.servers.plex).toMatchObject({ port: 32401, secretHint: "****1234" }); expect(response.body.servers.jellyfin).toMatchObject({ port: 8096, secretHint: "****9876" });
  const row = await db.setting.findUniqueOrThrow({ where: { key: "media.servers" } });
  expect(row.value).not.toMatch(/plex-token|jellyfin-key|abcd1234|wxyz9876/);
  expect(JSON.stringify((await get()).body)).not.toMatch(/plex-token|jellyfin-key/);
  const cleared = await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ plex: { secret: null } });
  expect(cleared.body.servers.plex).toMatchObject({ port: 32401, secretHint: null }); expect(cleared.body.servers.jellyfin.secretHint).toBe("****9876");
  for (const bad of [{ plex: { port: 80 } }, { plex: { port: "x" } }, { plex: { secret: "" } }, { plex: { other: 1 } }, { nope: {} }]) expect((await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send(bad)).status, JSON.stringify(bad)).toBe(400);
});

it("launches through the manager with the saved port, and passes a Plex claim token on without keeping it", async () => {
  const fake = await keep(serve(request => request.url === "/status" ? { json: { servers: { jellyfin: { state: "absent" }, plex: { state: "running", port: 32401 } } } } : { status: 202, json: { state: "pulling" } }));
  process.env.MEDIA_MANAGER_URL = fake.url; process.env.MEDIA_MANAGER_TOKEN = TOKEN;
  await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ plex: { port: 32401 } });
  const launched = await request(app).post("/api/admin/media-servers/plex/launch").set(auth(admin.token)).send({ claim: "claim-secretvalue123" });
  expect(launched.status).toBe(202); expect(launched.body).toEqual({ state: "pulling" });
  const call = fake.seen.find(entry => entry.url === "/servers/plex/launch")!;
  expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`); expect(JSON.parse(call.body)).toEqual({ port: 32401, claim: "claim-secretvalue123" });
  expect(JSON.stringify(launched.body)).not.toContain("claim-");
  expect(JSON.stringify(await db.setting.findMany())).not.toContain("claim-secretvalue123");
  const jellyfin = await request(app).post("/api/admin/media-servers/jellyfin/launch").set(auth(admin.token)).send({ port: 8100, claim: "claim-ignored" });
  expect(jellyfin.status).toBe(202); expect(JSON.parse(fake.seen.filter(entry => entry.url === "/servers/jellyfin/launch")[0].body)).toEqual({ port: 8100 });
  const view = await get(); expect(view.body.manager.available).toBe(true); expect(view.body.servers.plex).toMatchObject({ state: "running", port: 32401 }); expect(view.body.servers.jellyfin).toMatchObject({ state: "absent", port: 8100 });
  expect(JSON.stringify(view.body)).not.toContain("claim-");
});

it("says plainly when the manager refuses or cannot be reached", async () => {
  const fake = await keep(serve(() => ({ status: 400, json: { error: "That is not a Plex claim token (it starts with claim-)" } })));
  process.env.MEDIA_MANAGER_URL = fake.url; process.env.MEDIA_MANAGER_TOKEN = TOKEN;
  const refused = await request(app).post("/api/admin/media-servers/plex/launch").set(auth(admin.token)).send({ claim: "oops" });
  expect(refused.status).toBe(400); expect(refused.body.error).toMatch(/claim token/);
  process.env.MEDIA_MANAGER_URL = "http://127.0.0.1:1";
  const down = await request(app).post("/api/admin/media-servers/plex/launch").set(auth(admin.token)).send({});
  expect(down.status).toBe(502); expect(down.body.error).toMatch(/did not answer/i); expect(JSON.stringify(down.body)).not.toContain(TOKEN);
  expect((await get()).body.manager.available).toBe(false); // an unreachable manager is shown as not available
  expect((await request(app).post("/api/admin/media-servers/plex/launch").set(auth(admin.token)).send({ port: 80 })).status).toBe(400);
});

it("forwards stop and remove to the manager", async () => {
  const fake = await keep(serve(() => ({ json: { ok: true } })));
  process.env.MEDIA_MANAGER_URL = fake.url; process.env.MEDIA_MANAGER_TOKEN = TOKEN;
  expect((await request(app).post("/api/admin/media-servers/jellyfin/stop").set(auth(admin.token))).body).toEqual({ ok: true });
  expect((await request(app).delete("/api/admin/media-servers/plex").set(auth(admin.token))).body).toEqual({ ok: true });
  expect(fake.seen.map(entry => `${entry.method} ${entry.url}`)).toEqual(["POST /servers/jellyfin/stop", "DELETE /servers/plex"]);
});

it("asks Plex to rescan only the libraries StreamRD exports, with the saved token", async () => {
  const plex = await keep(serve(entry => entry.url === "/library/sections" ? { json: { MediaContainer: { Directory: [{ key: "1", Location: [{ path: "/library/streamrd/Movies" }] }, { key: "2", Location: [{ path: "/photos" }] }, { key: "x; DROP", Location: [{ path: "/library/evil" }] }, { key: "3", Location: [{ path: "/library/streamrd/TV Shows" }] }] } } } : { json: {} }));
  process.env.PLEX_URL = plex.url;
  expect((await request(app).post("/api/admin/media-servers/plex/refresh").set(auth(admin.token))).status).toBe(409); // no token saved yet
  await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ plex: { secret: "plex-token-abcd1234" } });
  const done = await request(app).post("/api/admin/media-servers/plex/refresh").set(auth(admin.token)); expect(done.status).toBe(200); expect(done.body).toEqual({ refreshed: 2 });
  expect(plex.seen.map(entry => entry.url)).toEqual(["/library/sections", "/library/sections/1/refresh", "/library/sections/3/refresh"]);
  expect(plex.seen.every(entry => entry.headers["x-plex-token"] === "plex-token-abcd1234")).toBe(true);
  await plex.close(); closers.pop(); process.env.PLEX_URL = "http://127.0.0.1:1";
  const unreachable = await request(app).post("/api/admin/media-servers/plex/refresh").set(auth(admin.token)); expect(unreachable.status).toBe(502); expect(JSON.stringify(unreachable.body)).not.toContain("abcd1234");
});

it("handles a token Plex or Jellyfin rejects, and rescans Jellyfin with its API key", async () => {
  const plex = await keep(serve(() => ({ status: 401, json: {} }))), jellyfin = await keep(serve(entry => ({ status: entry.headers["x-emby-token"] === "jellyfin-key-wxyz9876" ? 204 : 401 })));
  process.env.PLEX_URL = plex.url; process.env.JELLYFIN_URL = jellyfin.url;
  await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ plex: { secret: "wrong" }, jellyfin: { secret: "wrong" } });
  expect((await request(app).post("/api/admin/media-servers/plex/refresh").set(auth(admin.token))).body.error).toMatch(/did not accept that token/);
  expect((await request(app).post("/api/admin/media-servers/jellyfin/refresh").set(auth(admin.token))).body.error).toMatch(/did not accept that API key/);
  await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ jellyfin: { secret: "jellyfin-key-wxyz9876" } });
  expect((await request(app).post("/api/admin/media-servers/jellyfin/refresh").set(auth(admin.token))).body).toEqual({ refreshed: 1 });
  expect(jellyfin.seen.at(-1)).toMatchObject({ method: "POST", url: "/Library/Refresh" });
});

it("tests a connection: reachable or not, and whether the saved token was accepted", async () => {
  const jellyfin = await keep(serve(entry => ({ status: entry.url === "/System/Info/Public" || entry.headers["x-emby-token"] === "good-key" ? 200 : 401, json: {} })));
  process.env.JELLYFIN_URL = jellyfin.url; process.env.PLEX_URL = "http://127.0.0.1:1";
  expect((await request(app).post("/api/admin/media-servers/jellyfin/test").set(auth(admin.token))).body).toEqual({ reachable: true, accepted: null }); // no key saved: only reachability is known
  await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ jellyfin: { secret: "bad-key" } });
  expect((await request(app).post("/api/admin/media-servers/jellyfin/test").set(auth(admin.token))).body).toEqual({ reachable: true, accepted: false });
  await request(app).put("/api/admin/media-servers").set(auth(admin.token)).send({ jellyfin: { secret: "good-key" } });
  expect((await request(app).post("/api/admin/media-servers/jellyfin/test").set(auth(admin.token))).body).toEqual({ reachable: true, accepted: true });
  expect((await request(app).post("/api/admin/media-servers/plex/test").set(auth(admin.token))).body).toEqual({ reachable: false, accepted: null });
});
