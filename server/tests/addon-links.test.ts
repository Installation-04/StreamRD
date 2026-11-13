import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "./helpers";
import { ensureLogin, linkAddons, loginFor } from "../src/addon-links";

// Sonarr and Prowlarr are played by small servers that answer as they do: a host config that can be read and changed, and, for Prowlarr, the
// list of applications it sends indexers to. What the tests look at is what StreamRD asks of them, and that asking twice changes nothing.
const ENV = ["MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN", "DOCKER_CONTROL_STATE", "CONFIG_DIR", "SONARR_URL", "PROWLARR_URL", "RADARR_URL", "LIDARR_URL"];
const kept: Record<string, string | undefined> = {};
let servers: http.Server[] = [], dir = "";
const KEY = "a".repeat(32), PKEY = "b".repeat(32);

async function serve(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`); handler(req, body, res); }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
  return { calls, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const json = (res: http.ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
function arr(name: string, key: string) { fs.mkdirSync(path.join(dir, name, "config"), { recursive: true }); fs.writeFileSync(path.join(dir, name, "config", "config.xml"), `<Config><ApiKey>${key}</ApiKey></Config>`); }

beforeEach(async () => { for (const n of ENV) { kept[n] = process.env[n]; delete process.env[n]; } await resetDb(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "addon-links-")); process.env.CONFIG_DIR = dir; });
afterEach(async () => { for (const n of ENV) { if (kept[n] === undefined) delete process.env[n]; else process.env[n] = kept[n]; } await Promise.all(servers.splice(0).map(s => new Promise(done => s.close(done)))); fs.rmSync(dir, { recursive: true, force: true }); });

it("gives each add-on a login of its own making and tells Prowlarr about Sonarr, once, and again changes nothing", async () => {
  arr("sonarr", KEY); arr("prowlarr", PKEY);
  const host: Record<string, unknown> = { id: 1, authenticationMethod: "none", username: "", password: "" };
  const apps: Array<Record<string, unknown>> = [], phost: Record<string, unknown> = { id: 1, authenticationMethod: "none", username: "" };
  const sonarr = await serve((req, body, res) => {
    if (req.url === "/ping") return json(res, { status: "OK" });
    if (req.headers["x-api-key"] !== KEY) return json(res, {}, 401);
    if (req.url === "/api/v3/config/host" && req.method === "GET") return json(res, host);
    if (req.url === "/api/v3/config/host/1" && req.method === "PUT") { Object.assign(host, JSON.parse(body)); return json(res, host); }
    json(res, {}, 404);
  });
  const prowlarr = await serve((req, body, res) => {
    if (req.url === "/ping") return json(res, { status: "OK" });
    if (req.headers["x-api-key"] !== PKEY) return json(res, {}, 401);
    if (req.url === "/api/v1/config/host") return json(res, phost);
    if (req.url === "/api/v1/config/host/1") { Object.assign(phost, JSON.parse(body)); return json(res, phost); }
    if (req.url === "/api/v1/applications" && req.method === "GET") return json(res, apps);
    if (req.url === "/api/v1/applications/schema") return json(res, [{ implementation: "Sonarr", configContract: "SonarrSettings", fields: [{ name: "prowlarrUrl" }, { name: "baseUrl" }, { name: "apiKey" }, { name: "syncCategories", value: [5000] }] }]);
    if (req.url === "/api/v1/applications" && req.method === "POST") {
      const app = JSON.parse(body);
      // A default Docker bridge has no container-name DNS. Prowlarr validates
      // the connection, so an unresolvable alias is refused by the real API.
      if (app.fields.some((field: { name: string; value?: unknown }) => ["baseUrl", "prowlarrUrl"].includes(field.name) && String(field.value).startsWith("http://streamrd-"))) return json(res, {}, 400);
      apps.push(app); return json(res, {}, 201);
    }
    json(res, {}, 404);
  });
  const helper = await serve((req, _body, res) => json(res, { servers: { sonarr: { state: "running" }, prowlarr: { state: "running" }, radarr: { state: "absent" } } }));
  Object.assign(process.env, { MEDIA_MANAGER_URL: helper.url, MEDIA_MANAGER_TOKEN: "m".repeat(40), DOCKER_CONTROL_STATE: "embedded", SONARR_URL: sonarr.url, PROWLARR_URL: prowlarr.url });

  const [first, overlapping] = await Promise.all([linkAddons(), linkAddons()]);
  expect(overlapping).toEqual(first);
  expect(first).toMatchObject({ logins: ["sonarr", "prowlarr"], linked: ["sonarr"], errors: [] });
  const made = await loginFor("sonarr");
  expect(made).toMatchObject({ username: "streamrd" }); expect(made!.password.length).toBeGreaterThanOrEqual(20);
  expect(host).toMatchObject({ authenticationMethod: "forms", authenticationRequired: "enabled", username: "streamrd", password: made!.password, passwordConfirmation: made!.password });
  expect(apps).toHaveLength(1);
  expect(apps[0]).toMatchObject({ implementation: "Sonarr", configContract: "SonarrSettings", syncLevel: "fullSync" });
  const fields = Object.fromEntries((apps[0].fields as Array<{ name: string; value: unknown }>).map(f => [f.name, f.value]));
  expect(fields).toMatchObject({ baseUrl: sonarr.url, prowlarrUrl: prowlarr.url, apiKey: KEY, syncCategories: [5000] });
  const stored = (await (await import("../src/db")).db.setting.findUnique({ where: { key: "addons.logins" } }))!.value;
  expect(stored).not.toContain(made!.password);   // kept encrypted

  const second = await linkAddons();
  expect(second).toMatchObject({ logins: [], linked: [] });   // nothing to do
  expect(sonarr.calls.filter(c => c.startsWith("PUT"))).toHaveLength(1); expect(apps).toHaveLength(1);
});

it("leaves a login someone chose for themselves alone, and waits for an add-on that has not written its key yet", async () => {
  arr("sonarr", KEY);
  const sonarr = await serve((req, _b, res) => req.url === "/ping" ? json(res, {}) : req.url === "/api/v3/config/host" ? json(res, { id: 1, authenticationMethod: "forms", username: "mine" }) : json(res, {}, 500));
  const helper = await serve((_r, _b, res) => json(res, { servers: { sonarr: { state: "running" }, radarr: { state: "running" } } }));
  Object.assign(process.env, { MEDIA_MANAGER_URL: helper.url, MEDIA_MANAGER_TOKEN: "m".repeat(40), DOCKER_CONTROL_STATE: "embedded", SONARR_URL: sonarr.url });
  const report = await linkAddons();
  expect(report.logins).toEqual([]); expect(report.waiting).toEqual(["radarr"]); expect(await loginFor("sonarr")).toBeNull();
  expect(sonarr.calls.some(c => c.startsWith("PUT"))).toBe(false);
});

it("preserves an owner's replacement login after StreamRD has previously made one", async () => {
  const host: Record<string, unknown> = { id: 1, authenticationMethod: "none", username: "" };
  const sonarr = await serve((req, body, res) => {
    if (req.headers["x-api-key"] !== KEY) return json(res, {}, 401);
    if (req.url === "/api/v3/config/host" && req.method === "GET") return json(res, host);
    if (req.url === "/api/v3/config/host/1" && req.method === "PUT") { Object.assign(host, JSON.parse(body)); return json(res, host); }
    json(res, {}, 404);
  });

  expect(await ensureLogin("sonarr", sonarr.url, KEY)).toBe("set");
  Object.assign(host, { username: "owner", password: "owner-chosen-password" });

  expect(await ensureLogin("sonarr", sonarr.url, KEY)).toBe("kept");
  expect(await ensureLogin("sonarr", sonarr.url, KEY)).toBe("kept");
  expect(host).toMatchObject({ username: "owner", password: "owner-chosen-password" });
  expect(sonarr.calls.filter(call => call.startsWith("PUT"))).toHaveLength(1);
});
