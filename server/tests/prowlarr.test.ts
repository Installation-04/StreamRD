import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, adminAndUser, TestUser } from "./helpers";
import { db } from "../src/db";
import { ensureProwlarr, prowlarrApiKey, prowlarrView, syncIndexers } from "../src/prowlarr";
import { listIndexers } from "../src/requests/finder";

// The server writes its log lines in the background, so a test waits for the line to be there instead of reading the table at once.
const logged = (message: string) => db.logEvent.count({ where: { message } });
const sees = (message: string, times: number) => vi.waitFor(async () => expect(await logged(message)).toBe(times), { timeout: 5000, interval: 20 });

// Prowlarr keeps the indexers requests search. The Docker helper starts it (on by default); StreamRD reads its key from the shared settings
// folder and turns each enabled torrent indexer into a source for the release search.
const ENV = ["MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN", "DOCKER_CONTROL_STATE", "PROWLARR_URL", "CONFIG_DIR"];
const kept: Record<string, string | undefined> = {};
let admin: TestUser, member: TestUser, servers: http.Server[] = [], folder = "";
const KEY = "0123456789abcdef0123456789abcdef";
async function listen(handler: http.RequestListener) { const server = http.createServer(handler); await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
/** The Docker helper, as far as Prowlarr goes: what it says about the container, and what it was asked. */
async function helper(state: { state: string; port?: number; address?: string }) {
  const asked: string[] = [];
  const url = await listen((req, res) => {
    asked.push(`${req.method} ${req.url}`); res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/status") res.end(JSON.stringify({ servers: { jellyfin: { state: "absent" }, plex: { state: "absent" }, prowlarr: state } })); else res.end(JSON.stringify({ state: "pulling" }));
  });
  process.env.MEDIA_MANAGER_URL = url; process.env.MEDIA_MANAGER_TOKEN = "p".repeat(40); process.env.DOCKER_CONTROL_STATE = "embedded";
  return asked;
}
/** Prowlarr itself: a ping and its list of indexers. */
async function prowlarr(indexers: unknown[]) {
  const seen: string[] = [];
  const url = await listen((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers["x-api-key"] ?? ""}`); res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.url === "/ping" ? JSON.stringify({ status: "OK" }) : req.url === "/api/v1/indexer" && req.headers["x-api-key"] === KEY ? JSON.stringify(indexers) : "[]");
  });
  process.env.PROWLARR_URL = url; return { url, seen };
}
const writeKey = (key = KEY) => { fs.mkdirSync(path.join(folder, "prowlarr", "config"), { recursive: true }); fs.writeFileSync(path.join(folder, "prowlarr", "config", "config.xml"), `<Config><Port>9696</Port><ApiKey>${key}</ApiKey></Config>`); };
beforeEach(async () => {
  for (const name of ENV) { kept[name] = process.env[name]; delete process.env[name]; }
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "prowlarr-")); process.env.CONFIG_DIR = folder;
  await resetDb(); ({ admin, user: member } = await adminAndUser());
});
afterEach(async () => {
  for (const name of ENV) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; }
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done)))); fs.rmSync(folder, { recursive: true, force: true });
});

it("reads Prowlarr's API key from the settings folder it shares, and nothing else in the file", () => {
  expect(prowlarrApiKey(folder)).toBe("");   // not started yet
  writeKey(); expect(prowlarrApiKey(folder)).toBe(KEY);
  fs.writeFileSync(path.join(folder, "prowlarr", "config", "config.xml"), "<Config><ApiKey>short</ApiKey></Config>"); expect(prowlarrApiKey(folder)).toBe("");
});

it("starts Prowlarr by itself when Docker control is on, once, and stays out of the way when it is off", async () => {
  expect(await ensureProwlarr()).toBe("unavailable");
  expect(await prowlarrView()).toMatchObject({ available: false, state: "unknown", declined: false });
  const asked = await helper({ state: "absent" });
  expect(await ensureProwlarr()).toBe("started");
  expect(asked).toEqual(["GET /status", "POST /servers/prowlarr/launch"]);
  await sees("Starting Prowlarr, which finds releases for requests", 1);
  asked.length = 0; await helper({ state: "pulling" }); expect(await ensureProwlarr()).toBe("starting");   // it is on its way: nothing more is asked
});

it("keeps what an administrator removes removed, and starts it again when asked", async () => {
  const asked = await helper({ state: "running", port: 9696 });
  expect((await request(app).delete("/api/admin/prowlarr").set(auth(member.token))).status).toBe(403);
  const removed = await request(app).delete("/api/admin/prowlarr").set(auth(admin.token));
  expect(removed.status).toBe(200); expect(removed.body.prowlarr.declined).toBe(true); expect(asked).toContain("DELETE /servers/prowlarr");
  asked.length = 0; expect(await ensureProwlarr()).toBe("declined"); expect(asked).toEqual([]);   // not started again at the next start-up
  await helper({ state: "absent" });
  const started = await request(app).post("/api/admin/prowlarr/start").set(auth(admin.token));
  expect(started.status).toBe(202); expect(started.body.prowlarr.declined).toBe(false);
});

it("turns every enabled torrent indexer in Prowlarr into a source for the release search, found automatically and not removable here", async () => {
  await helper({ state: "running", port: 9696 }); writeKey();
  const fake = await prowlarr([{ id: 1, name: "Public tracker", enable: true, protocol: "torrent" }, { id: 2, name: "Usenet one", enable: true, protocol: "usenet" }, { id: 3, name: "Switched off", enable: false, protocol: "torrent" }, { id: 4, name: "Another", enable: true, protocol: "torrent" }, { nope: true }]);
  expect(await listIndexers()).toEqual([]);                       // nothing is known until the first sync
  expect(await syncIndexers()).toBe(2);
  const sources = await listIndexers();
  expect(sources.map(source => source.id)).toEqual(["prowlarr-1", "prowlarr-4"]);
  expect(sources[0]).toMatchObject({ name: "Prowlarr · Public tracker", baseUrl: `${fake.url}/1/api`, apiKey: KEY, builtin: true });
  expect(fake.seen).toContain(`GET /api/v1/indexer ${KEY}`);
  const listed = await request(app).get("/api/admin/request-indexers").set(auth(admin.token));
  expect(listed.body.indexers.map((entry: { id: string; builtin: boolean }) => [entry.id, entry.builtin])).toEqual([["prowlarr-1", true], ["prowlarr-4", true]]);
  expect(JSON.stringify(listed.body)).not.toContain(KEY);          // the key is never sent to the page
  const refused = await request(app).delete("/api/admin/request-indexers/prowlarr-1").set(auth(admin.token));
  expect(refused.status).toBe(409); expect(refused.body.error).toMatch(/comes from Prowlarr/);
  await sees("Prowlarr has 2 indexers for release search", 1);
  await syncIndexers(); await new Promise(done => setTimeout(done, 150)); expect(await logged("Prowlarr has 2 indexers for release search")).toBe(1);   // said once, not at every sync
});

it("says nothing is known when Prowlarr cannot be asked: no key yet, no answer, or an answer that is not a list", async () => {
  await helper({ state: "running", port: 9696 });
  expect(await syncIndexers()).toBeNull();                       // no key file
  writeKey(); expect(await syncIndexers()).toBeNull();           // no answer at that address
  process.env.PROWLARR_URL = await listen((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"not":"a list"}'); });
  expect(await syncIndexers()).toBeNull();
  const view = await prowlarrView(); expect(view).toMatchObject({ state: "running", keyFound: true, indexers: 0 });
});
