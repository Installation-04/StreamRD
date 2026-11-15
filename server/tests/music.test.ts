import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, adminAndUser, TestUser } from "./helpers";

// Lidarr and the Docker helper are played by small servers. What the tests look at is what StreamRD asks Lidarr for, who may ask, and what it
// refuses to pass on.
const ENV = ["MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN", "DOCKER_CONTROL_STATE", "CONFIG_DIR", "LIDARR_URL"];
const kept: Record<string, string | undefined> = {};
let servers: http.Server[] = [], dir = "", admin: TestUser, member: TestUser;
const ID = "11111111-2222-3333-4444-555555555555", OTHER = "99999999-2222-3333-4444-555555555555";
async function serve(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`); handler(req, body, res); }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
  return { calls, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const json = (res: http.ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
beforeEach(async () => { for (const n of ENV) { kept[n] = process.env[n]; delete process.env[n]; } await resetDb(); ({ admin, user: member } = await adminAndUser()); dir = fs.mkdtempSync(path.join(os.tmpdir(), "music-")); process.env.CONFIG_DIR = dir; });
afterEach(async () => { for (const n of ENV) { if (kept[n] === undefined) delete process.env[n]; else process.env[n] = kept[n]; } await Promise.all(servers.splice(0).map(s => new Promise(done => s.close(done)))); fs.rmSync(dir, { recursive: true, force: true }); });

async function lidarr(albums: Record<string, Record<string, unknown>>, running = true) {
  fs.mkdirSync(path.join(dir, "lidarr", "config"), { recursive: true }); fs.writeFileSync(path.join(dir, "lidarr", "config", "config.xml"), `<Config><ApiKey>${"c".repeat(32)}</ApiKey></Config>`);
  const stored: Record<string, Record<string, unknown>> = {};
  const fake = await serve((req, body, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/ping") return json(res, {});
    if (url.pathname === "/api/v1/album/lookup") { const term = url.searchParams.get("term") ?? ""; const list = Object.values(albums).filter(a => term.startsWith("lidarr:") ? a.foreignAlbumId === term.slice(7) : String(a.title).toLowerCase().includes(term.toLowerCase())); return json(res, list.map(a => stored[String(a.foreignAlbumId)] ?? a)); }
    if (url.pathname === "/api/v1/qualityprofile") return json(res, [{ id: 2 }]);
    if (url.pathname === "/api/v1/metadataprofile") return json(res, [{ id: 3 }]);
    if (url.pathname === "/api/v1/rootfolder") return json(res, [{ path: "/data/media/music" }]);
    if (url.pathname === "/api/v1/album" && req.method === "POST") { const sent = JSON.parse(body); stored[sent.foreignAlbumId] = { ...sent, id: 41 }; return json(res, stored[sent.foreignAlbumId], 201); }
    const one = /^\/api\/v1\/album\/(\d+)$/.exec(url.pathname), known = Object.values(stored).find(a => `${a.id}` === one?.[1]);
    if (one && known && req.method === "GET") return json(res, known);
    if (one && known && req.method === "PUT") { Object.assign(known, JSON.parse(body)); return json(res, known); }
    if (url.pathname === "/api/v1/command") return json(res, {}, 201);
    json(res, {}, 404);
  });
  const helper = await serve((_req, _b, res) => json(res, { servers: { lidarr: { state: running ? "running" : "stopped" } } }));
  Object.assign(process.env, { MEDIA_MANAGER_URL: helper.url, MEDIA_MANAGER_TOKEN: "m".repeat(40), DOCKER_CONTROL_STATE: "embedded", LIDARR_URL: fake.url });
  return fake;
}
const OK = { id: 0, title: "OK Computer", foreignAlbumId: ID, releaseDate: "1997-05-21T00:00:00Z", albumType: "Album", monitored: false, images: [{ coverType: "cover", remoteUrl: "https://img.example/cover.jpg" }], artist: { artistName: "Radiohead", foreignArtistId: OTHER } };

it("searches albums through Lidarr for signed-in people only, and says so plainly when Lidarr is not running", async () => {
  await lidarr({ ok: OK, other: { ...OK, title: "The Bends", foreignAlbumId: OTHER, id: 9, monitored: true, statistics: { percentOfTracks: 100 } }, bad: { title: "No id", foreignAlbumId: "not-a-uuid" } });
  expect((await request(app).get("/api/music/search?q=ok")).status).toBe(401);
  expect((await request(app).get("/api/music/status").set(auth(member.token))).body).toEqual({ available: true });
  const found = await request(app).get("/api/music/search?q=ok").set(auth(member.token));
  expect(found.status).toBe(200);
  expect(found.body.results).toEqual([{ id: ID, title: "OK Computer", artist: "Radiohead", year: 1997, kind: "Album", coverUrl: "https://img.example/cover.jpg", status: null }]);
  const both = await request(app).get("/api/music/search?q=the").set(auth(member.token));
  expect(both.body.results.map((r: { status: string | null }) => r.status)).toEqual(["available"]);   // complete in the library
  expect((await request(app).get("/api/music/search?q=x").set(auth(member.token))).status).toBe(400);
  expect(JSON.stringify(found.body)).not.toMatch(/cccccccc/);   // Lidarr's key never leaves the server
});

it("says Lidarr is needed when it is not running", async () => {
  await lidarr({ ok: OK }, false);
  expect((await request(app).get("/api/music/status").set(auth(member.token))).body).toEqual({ available: false });
  const refused = await request(app).get("/api/music/search?q=ok computer").set(auth(member.token));
  expect(refused.status).toBe(409); expect(refused.body.error).toMatch(/Lidarr/);
  expect((await request(app).post("/api/music/request").set(auth(member.token)).send({ id: ID })).status).toBe(409);
});

it("adds the album, monitored and searched, with its artist left unmonitored, and passes on nothing the person typed", async () => {
  const fake = await lidarr({ ok: OK });
  for (const body of [{}, { id: "x" }, { id: ID, extra: 1 }, { id: ID, artist: { rootFolderPath: "/etc" } }]) expect((await request(app).post("/api/music/request").set(auth(member.token)).send(body)).status, JSON.stringify(body)).toBe(400);
  expect(fake.calls.filter(c => c.startsWith("POST"))).toEqual([]);
  const asked = await request(app).post("/api/music/request").set(auth(member.token)).send({ id: ID });
  expect(asked.status).toBe(202); expect(asked.body).toEqual({ status: "requested" });
  const posted = JSON.parse(fake.calls.find(c => c.startsWith("POST /api/v1/album "))!.replace("POST /api/v1/album ", ""));
  expect(posted).toMatchObject({ foreignAlbumId: ID, monitored: true, addOptions: { searchForNewAlbum: true }, artist: { foreignArtistId: OTHER, qualityProfileId: 2, metadataProfileId: 3, rootFolderPath: "/data/media/music", monitorNewItems: "none", addOptions: { monitor: "none" } } });
  expect(fake.calls.some(c => c.startsWith("POST /api/v1/command") && c.includes("AlbumSearch"))).toBe(true);
  // It now shows as requested, and asking again does not add it twice.
  expect((await request(app).get("/api/music/search?q=ok").set(auth(member.token))).body.results[0].status).toBe("requested");
  expect((await request(app).post("/api/music/request").set(auth(member.token)).send({ id: ID })).status).toBe(202);
  expect(fake.calls.filter(c => c.startsWith("POST /api/v1/album ")).length).toBe(1);
  expect(fake.calls.some(c => c.startsWith("PUT /api/v1/album/41 "))).toBe(true);   // already known: monitored again, not added again
});
