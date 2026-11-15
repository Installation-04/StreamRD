import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "./helpers";
import { bazarrKey, ensureBazarrSources, ensureFlareSolverr, ensureRootFolder } from "../src/addon-links";

// Add-ons are played by small servers that answer as the real ones do; the tests look at what StreamRD asks of them and that a second pass changes nothing.
let servers: http.Server[] = [], dir = "";
async function serve(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); calls.push(`${req.method} ${req.url}`); handler(req, body, res); }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
  return { calls, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const json = (res: http.ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
beforeEach(async () => { await resetDb(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "addon-setup-")); });
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(done => s.close(done)))); fs.rmSync(dir, { recursive: true, force: true }); });

it("gives Sonarr and Lidarr a folder under the data folder when they have none, and leaves one someone added", async () => {
  const roots: Array<Record<string, unknown>> = [];
  const sonarr = await serve((req, body, res) => {
    if (req.url === "/api/v3/rootfolder" && req.method === "GET") return json(res, roots);
    if (req.url === "/api/v3/rootfolder" && req.method === "POST") { roots.push(JSON.parse(body)); return json(res, {}, 201); }
    json(res, {}, 404);
  });
  expect(await ensureRootFolder("sonarr", sonarr.base, "k", dir)).toBe(true);
  expect(roots).toEqual([{ path: path.join(dir, "media", "tv") }]);
  expect(fs.statSync(path.join(dir, "media", "tv")).isDirectory()).toBe(true);   // made first: the add-on refuses a folder that is not there
  expect(await ensureRootFolder("sonarr", sonarr.base, "k", dir)).toBe(false);
  const lroots: Array<Record<string, unknown>> = [];
  const lidarr = await serve((req, body, res) => {
    if (req.url === "/api/v1/rootfolder" && req.method === "GET") return json(res, lroots);
    if (req.url === "/api/v1/qualityprofile") return json(res, [{ id: 4 }]);
    if (req.url === "/api/v1/metadataprofile") return json(res, [{ id: 7 }]);
    if (req.url === "/api/v1/rootfolder" && req.method === "POST") { lroots.push(JSON.parse(body)); return json(res, {}, 201); }
    json(res, {}, 404);
  });
  expect(await ensureRootFolder("lidarr", lidarr.base, "k", dir)).toBe(true);
  expect(lroots[0]).toMatchObject({ path: path.join(dir, "media", "music"), name: "Music", defaultQualityProfileId: 4, defaultMetadataProfileId: 7 });
  const mine = await serve((req, _b, res) => req.url === "/api/v3/rootfolder" && req.method === "GET" ? json(res, [{ path: "/mine" }]) : json(res, {}, 500));
  expect(await ensureRootFolder("radarr", mine.base, "k", dir)).toBe(false);
  expect(mine.calls).toEqual(["GET /api/v3/rootfolder"]); expect(fs.existsSync(path.join(dir, "media", "movies"))).toBe(false);
});

it("tells Prowlarr about FlareSolverr once, under a tag of its own", async () => {
  const proxies: Array<Record<string, unknown>> = [], tags: Array<{ id: number; label: string }> = [];
  const prowlarr = await serve((req, body, res) => {
    if (req.url === "/api/v1/indexerProxy" && req.method === "GET") return json(res, proxies);
    if (req.url === "/api/v1/indexerProxy/schema") return json(res, [{ implementation: "FlareSolverr", configContract: "FlareSolverrSettings", fields: [{ name: "host" }, { name: "requestTimeout" }] }]);
    if (req.url === "/api/v1/tag" && req.method === "GET") return json(res, tags);
    if (req.url === "/api/v1/tag" && req.method === "POST") { const made = { id: 3, label: JSON.parse(body).label }; tags.push(made); return json(res, made); }
    if (req.url === "/api/v1/indexerProxy" && req.method === "POST") { proxies.push({ ...JSON.parse(body), implementation: "FlareSolverr" }); return json(res, {}, 201); }
    json(res, {}, 404);
  });
  expect(await ensureFlareSolverr({ base: prowlarr.base, key: "k" }, "http://streamrd-flaresolverr:8191")).toBe(true);
  expect(proxies[0]).toMatchObject({ name: "FlareSolverr", configContract: "FlareSolverrSettings", tags: [3] });
  expect(Object.fromEntries((proxies[0].fields as Array<{ name: string; value: unknown }>).map(f => [f.name, f.value]))).toEqual({ host: "http://streamrd-flaresolverr:8191", requestTimeout: 60 });
  expect(await ensureFlareSolverr({ base: prowlarr.base, key: "k" }, "http://x:8191")).toBe(false);
  expect(proxies).toHaveLength(1);
});

it("points Bazarr at Sonarr and Radarr once, and leaves a source someone filled in", async () => {
  const settings: Record<string, Record<string, unknown>> = { sonarr: { apikey: "" }, radarr: { apikey: "theirs" } };
  const posted: string[] = [];
  const bazarr = await serve((req, body, res) => {
    if (req.url === "/api/system/settings" && req.method === "GET") return json(res, settings);
    if (req.url === "/api/system/settings" && req.method === "POST") { posted.push(body); settings.sonarr = { apikey: "sonarrkey" }; return json(res, {}, 204); }
    json(res, {}, 404);
  });
  const sources = { sonarr: { base: "http://streamrd-sonarr:8989", key: "sonarrkey" }, radarr: { base: "http://streamrd-radarr:7878", key: "radarrkey" } };
  expect(await ensureBazarrSources({ base: bazarr.base, key: "b" }, sources)).toEqual(["sonarr"]);
  const form = new URLSearchParams(posted[0]);
  expect(Object.fromEntries(form)).toMatchObject({ "settings-sonarr-ip": "streamrd-sonarr", "settings-sonarr-port": "8989", "settings-sonarr-apikey": "sonarrkey", "settings-general-use_sonarr": "true" });
  expect(form.has("settings-radarr-apikey")).toBe(false);
  expect(await ensureBazarrSources({ base: bazarr.base, key: "b" }, sources)).toEqual([]);
  expect(posted).toHaveLength(1);
});

it("reads Bazarr's key from its yaml or ini settings", () => {
  fs.mkdirSync(path.join(dir, "bazarr", "config"), { recursive: true });
  expect(bazarrKey(dir)).toBe("");
  fs.writeFileSync(path.join(dir, "bazarr", "config", "config.yaml"), "auth:\n  apikey: abcdef0123456789abcdef0123456789\n");
  expect(bazarrKey(dir)).toBe("abcdef0123456789abcdef0123456789");
});
