import http from "node:http";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, adminAndUser, TestUser } from "./helpers";
import { db } from "../src/db";
import { CATALOG } from "../src/addons";

// The add-on marketplace: a list of programs people run next to a media server, each started by the Docker helper from a fixed
// specification. The helper is played by a small server that says what is running and records what it is asked; what these tests look at
// is what StreamRD asks it, what it keeps, who may ask, and that nothing outside the catalog can be named.
const ENV = ["MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN", "DOCKER_CONTROL_STATE"];
const kept: Record<string, string | undefined> = {};
let admin: TestUser, member: TestUser, servers: http.Server[] = [];
const NAMES = ["sonarr", "radarr", "lidarr", "bazarr", "seerr", "tautulli", "prowlarr", "flaresolverr", "maintainerr"];

async function helper(running: Record<string, Record<string, unknown>> = {}) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8"); asked.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/status") res.end(JSON.stringify({ servers: running }));
      else if (/\/logs/.test(req.url ?? "")) res.end(JSON.stringify({ deploy: [{ time: "2026-11-12T10:00:00Z", message: "Started." }], container: ["ready"] }));
      else res.end(JSON.stringify({ state: "pulling" }));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
  process.env.MEDIA_MANAGER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`; process.env.MEDIA_MANAGER_TOKEN = "m".repeat(40); process.env.DOCKER_CONTROL_STATE = "embedded";
  return asked;
}
beforeEach(async () => { for (const name of ENV) { kept[name] = process.env[name]; delete process.env[name]; } await resetDb(); ({ admin, user: member } = await adminAndUser()); });
afterEach(async () => {
  for (const name of ENV) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; }
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))));
});

it("lists the catalog with what is running, in plain words, for administrators only", async () => {
  await helper({ sonarr: { state: "running", port: 8990, autostart: true }, radarr: { state: "failed", error: "port is already allocated" }, bazarr: { state: "stopped", port: 6767, autostart: false } });
  expect((await request(app).get("/api/admin/addons")).status).toBe(401);
  expect((await request(app).get("/api/admin/addons").set(auth(member.token))).status).toBe(403);
  const listed = await request(app).get("/api/admin/addons").set(auth(admin.token));
  expect(listed.status).toBe(200);
  expect(listed.body.control).toEqual({ mode: "embedded", reason: null });
  expect(listed.body.addons.map((one: { name: string }) => one.name).sort()).toEqual([...NAMES].sort());
  const by = Object.fromEntries(listed.body.addons.map((one: { name: string }) => [one.name, one]));
  expect(by.sonarr).toMatchObject({ label: "Sonarr", state: "running", port: 8990, autostart: true, ui: true, licence: "GPL-3.0", error: null });
  expect(by.radarr).toMatchObject({ state: "failed", error: "port is already allocated", port: 7878 });
  expect(by.bazarr).toMatchObject({ state: "stopped", autostart: false });
  expect(by.seerr).toMatchObject({ state: "absent", port: 5055, licence: "MIT" });
  expect(by.flaresolverr.ui).toBe(false);   // nothing to open: Prowlarr talks to it
  for (const one of listed.body.addons) { expect(one.blurb.length).toBeGreaterThan(20); expect(one.home).toMatch(/^https:\/\//); expect(listed.body.groups).toContain(one.group); }
  expect(Object.keys(CATALOG).sort()).toEqual([...NAMES].sort());
  expect(JSON.stringify(listed.body)).not.toMatch(/mmmmmmmm|Bearer/);
});

it("starts an add-on with the port and start-with-the-machine choice kept for next time, and asks the helper for nothing else", async () => {
  const asked = await helper();
  expect((await request(app).post("/api/admin/addons/sonarr/launch").send({})).status).toBe(401);
  expect((await request(app).post("/api/admin/addons/sonarr/launch").set(auth(member.token)).send({})).status).toBe(403);
  const started = await request(app).post("/api/admin/addons/sonarr/launch").set(auth(admin.token)).send({ port: 8999, autostart: false });
  expect(started.status).toBe(202);
  expect(asked).toContain(`POST /servers/sonarr/launch ${JSON.stringify({ port: 8999, autostart: false })}`);
  // The choice is remembered: starting it again without saying anything uses it.
  await request(app).post("/api/admin/addons/sonarr/launch").set(auth(admin.token)).send({});
  expect(asked.filter(line => line.startsWith("POST /servers/sonarr/launch")).pop()).toBe(`POST /servers/sonarr/launch ${JSON.stringify({ port: 8999, autostart: false })}`);
  expect((await db.setting.findUnique({ where: { key: "addons.state" } }))!.value).toContain("8999");
  expect(await db.logEvent.count({ where: { message: "Started Sonarr", type: "admin_action" } })).toBe(2);
  // Only a port in range and a boolean are accepted; nothing else can be passed on to the helper.
  for (const body of [{ port: 80 }, { port: 99999 }, { port: "8000" }, { autostart: "yes" }, { image: "evil/image" }, { env: ["A=B"] }, { claim: "claim-x" }]) {
    expect((await request(app).post("/api/admin/addons/sonarr/launch").set(auth(admin.token)).send(body)).status, JSON.stringify(body)).toBe(400);
  }
  expect(asked.filter(line => line.includes("evil") || line.includes("A=B") || line.includes("claim-"))).toEqual([]);
});

it("refuses a name that is not in the catalog, however it is spelled", async () => {
  const asked = await helper();
  for (const name of ["nothing", "plex", "jellyfin", "SONARR", "sonarr%2F..%2Fplex", "__proto__", "constructor"]) {
    for (const [method, suffix] of [["post", "/launch"], ["post", "/stop"], ["delete", ""], ["get", "/logs"], ["put", "/autostart"]] as const) {
      const res = await request(app)[method](`/api/admin/addons/${name}${suffix}`).set(auth(admin.token)).send({ enabled: true });
      expect([400, 404], `${method} ${name}${suffix}`).toContain(res.status);
    }
  }
  expect(asked.filter(line => !line.startsWith("GET /status"))).toEqual([]);   // nothing reached the helper
});

it("stops, removes (keeping what it stored) and sets start-with-the-machine through the helper", async () => {
  const asked = await helper({ radarr: { state: "running", port: 7878, autostart: true } });
  expect((await request(app).post("/api/admin/addons/radarr/stop").set(auth(admin.token))).status).toBe(200);
  expect(asked).toContain("POST /servers/radarr/stop");
  expect((await request(app).put("/api/admin/addons/radarr/autostart").set(auth(admin.token)).send({ enabled: false })).status).toBe(200);
  expect(asked).toContain(`POST /servers/radarr/autostart ${JSON.stringify({ enabled: false })}`);
  expect((await request(app).put("/api/admin/addons/radarr/autostart").set(auth(admin.token)).send({ enabled: "no" })).status).toBe(400);
  expect((await request(app).delete("/api/admin/addons/radarr").set(auth(admin.token))).status).toBe(200);
  expect(asked).toContain("DELETE /servers/radarr");
  expect(await db.logEvent.count({ where: { message: "Removed Radarr", type: "admin_action" } })).toBe(1);
  const logs = await request(app).get("/api/admin/addons/radarr/logs?tail=50").set(auth(admin.token));
  expect(logs.status).toBe(200); expect(logs.body).toEqual({ deploy: [{ time: "2026-11-12T10:00:00Z", message: "Started." }], container: ["ready"] });
  expect(asked).toContain("GET /servers/radarr/logs?tail=50");
  expect((await request(app).get("/api/admin/addons/radarr/logs?tail=9999").set(auth(admin.token))).status).toBe(400);
});

it("treats Prowlarr as an add-on too: removing it is remembered, and starting it clears that", async () => {
  const asked = await helper({ prowlarr: { state: "absent" } });
  expect((await request(app).delete("/api/admin/addons/prowlarr").set(auth(admin.token))).status).toBe(200);
  expect(asked).toContain("DELETE /servers/prowlarr");
  expect(JSON.parse((await db.setting.findUnique({ where: { key: "prowlarr.state" } }))!.value)).toMatchObject({ declined: true });
  expect((await request(app).post("/api/admin/addons/prowlarr/launch").set(auth(admin.token)).send({})).status).toBe(202);
  expect(JSON.parse((await db.setting.findUnique({ where: { key: "prowlarr.state" } }))!.value)).toMatchObject({ declined: false });
  expect(asked.some(line => line.startsWith("POST /servers/prowlarr/launch"))).toBe(true);
});

it("says plainly that Docker control is off and does not pretend an add-on started", async () => {
  delete process.env.MEDIA_MANAGER_URL; delete process.env.MEDIA_MANAGER_TOKEN; process.env.DOCKER_CONTROL_STATE = "off";
  const listed = await request(app).get("/api/admin/addons").set(auth(admin.token));
  expect(listed.status).toBe(200); expect(listed.body.control.mode).toBe("off");
  expect(listed.body.addons.every((one: { state: string }) => one.state === "unknown")).toBe(true);
  const started = await request(app).post("/api/admin/addons/sonarr/launch").set(auth(admin.token)).send({});
  expect(started.status).toBe(409); expect(started.body.error).toMatch(/Docker control/);
});
