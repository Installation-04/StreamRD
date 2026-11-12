import http from "node:http";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, adminAndUser, TestUser } from "./helpers";
import { db } from "../src/db";
import { runAutomaticUpdates } from "../src/modules";

// The programs StreamRD runs next to itself (Prowlarr, Jellyfin, Plex) are updated from here, through the Docker helper, whenever a newer
// version exists and not only when StreamRD is. The helper is played by a small server that says what each module is and what its last
// check found; what these tests look at is what StreamRD asks it, what it keeps, and when it asks.
const ENV = ["MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN", "DOCKER_CONTROL_STATE", "TZ"];
const kept: Record<string, string | undefined> = {};
let admin: TestUser, member: TestUser, servers: http.Server[] = [];
const logged = (message: string) => db.logEvent.count({ where: { message } });
const sees = (message: string, times: number) => vi.waitFor(async () => expect(await logged(message)).toBe(times), { timeout: 5000, interval: 20 });
const idle = (version: string) => ({ state: "idle", current: { version, created: "2026-10-01T10:00:00Z" } });

interface Script { servers: Record<string, { state: string }>; updates: Record<string, Record<string, unknown>> }
async function helper(script: Script) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8"); asked.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      const one = /^\/servers\/(\w+)\/update$/.exec(req.url ?? "");
      if (req.url === "/status") res.end(JSON.stringify({ servers: script.servers }));
      else if (one && req.method === "GET") res.end(JSON.stringify(script.updates[one[1]] ?? idle("1.0.0")));
      else res.end(JSON.stringify({ state: "running" }));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
  process.env.MEDIA_MANAGER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`; process.env.MEDIA_MANAGER_TOKEN = "m".repeat(40); process.env.DOCKER_CONTROL_STATE = "embedded";
  return asked;
}
const THREE = { prowlarr: { state: "running" }, jellyfin: { state: "absent" }, plex: { state: "stopped" } };

beforeEach(async () => { for (const name of ENV) { kept[name] = process.env[name]; delete process.env[name]; } await resetDb(); ({ admin, user: member } = await adminAndUser()); });
afterEach(async () => {
  for (const name of ENV) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; }
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))));
});

it("lists the modules that are there with the version they run, asks about the others nothing, and is for administrators only", async () => {
  const asked = await helper({ servers: THREE, updates: { prowlarr: idle("1.30.0"), plex: idle("1.41.0") } });
  expect((await request(app).get("/api/admin/modules")).status).toBe(401);
  expect((await request(app).get("/api/admin/modules").set(auth(member.token))).status).toBe(403);
  const listed = await request(app).get("/api/admin/modules").set(auth(admin.token));
  expect(listed.status).toBe(200);
  expect(listed.body.control).toEqual({ mode: "embedded", reason: null });
  expect(listed.body.window).toEqual({ from: 3, to: 5, timezone: expect.any(String) });
  expect(listed.body.modules.map((one: { name: string; state: string; version: string | null; auto: boolean; updateAvailable: boolean }) => [one.name, one.state, one.version, one.auto, one.updateAvailable])).toEqual([
    ["prowlarr", "running", "1.30.0", false, false], ["jellyfin", "absent", null, false, false], ["plex", "stopped", "1.41.0", false, false]]);
  expect(asked).not.toContain("GET /servers/jellyfin/update");   // nothing to ask about a module that was never started
  expect(JSON.stringify(listed.body)).not.toMatch(/mmmmmmmm|Bearer/);
});

it("asks the helper to look for a newer version without changing anything, and keeps the answer after the helper has forgotten it", async () => {
  const script: Script = { servers: THREE, updates: { prowlarr: idle("1.30.0") } };
  const asked = await helper(script);
  const check = await request(app).post("/api/admin/modules/prowlarr/check").set(auth(admin.token));
  expect(check.status).toBe(202);
  expect(asked).toContain('POST /servers/prowlarr/update {"apply":false}');
  script.updates.prowlarr = { state: "available", apply: false, finishedAt: "2026-11-12T09:00:00.000Z", current: { version: "1.30.0", created: "2026-10-01T10:00:00Z" }, available: { version: "1.31.0", created: "2026-11-10T10:00:00Z" } };
  const found = (await request(app).get("/api/admin/modules").set(auth(admin.token))).body.modules[0];
  expect(found).toMatchObject({ name: "prowlarr", updateAvailable: true, availableVersion: "1.31.0", checkedAt: "2026-11-12T09:00:00.000Z", version: "1.30.0", update: { state: "available" } });
  script.updates.prowlarr = idle("1.30.0");   // the helper restarted and remembers nothing
  expect((await request(app).get("/api/admin/modules").set(auth(admin.token))).body.modules[0]).toMatchObject({ updateAvailable: true, availableVersion: "1.31.0", checkedAt: "2026-11-12T09:00:00.000Z", update: null });
  script.updates.prowlarr = { state: "current", finishedAt: "2026-11-12T10:00:00.000Z", current: { version: "1.31.0", created: "2026-11-10T10:00:00Z" } };
  expect((await request(app).get("/api/admin/modules").set(auth(admin.token))).body.modules[0]).toMatchObject({ updateAvailable: false, availableVersion: null, checkedAt: "2026-11-12T10:00:00.000Z" });   // checked again: nothing newer
});

it("updates on request, records that it was done once, and says what was asked in the log", async () => {
  const script: Script = { servers: THREE, updates: { prowlarr: idle("1.30.0") } };
  const asked = await helper(script);
  const update = await request(app).post("/api/admin/modules/prowlarr/update").set(auth(admin.token));
  expect(update.status).toBe(202); expect(asked).toContain('POST /servers/prowlarr/update {"apply":true}');
  await sees("Started updating Prowlarr", 1);
  script.updates.prowlarr = { state: "running", apply: true, step: "Stopping prowlarr to start the new version (it is back in a minute)", current: { version: "1.30.0", created: "2026-10-01T10:00:00Z" } };
  expect((await request(app).get("/api/admin/modules").set(auth(admin.token))).body.modules[0].update).toEqual({ state: "running", apply: true, step: expect.stringMatching(/^Stopping prowlarr/), error: "" });
  script.updates.prowlarr = { state: "updated", apply: true, finishedAt: "2026-11-12T09:05:00.000Z", current: { version: "1.31.0", created: "2026-11-10T10:00:00Z" }, available: { version: "1.31.0", created: "2026-11-10T10:00:00Z" } };
  for (let i = 0; i < 3; i++) expect((await request(app).get("/api/admin/modules").set(auth(admin.token))).body.modules[0]).toMatchObject({ version: "1.31.0", updateAvailable: false, updatedAt: "2026-11-12T09:05:00.000Z" });
  await sees("Prowlarr was updated to 1.31.0", 1);   // once, however often the page asks
  script.updates.prowlarr = { state: "failed", apply: true, finishedAt: "2026-11-12T09:30:00.000Z", error: "The new version did not start properly. The previous version was restored; its settings were not touched.", current: { version: "1.30.0", created: "2026-10-01T10:00:00Z" } };
  const failed = (await request(app).get("/api/admin/modules").set(auth(admin.token))).body.modules[0];
  expect(failed.update).toMatchObject({ state: "failed", error: expect.stringMatching(/previous version was restored/) });
  expect(failed.updatedAt).toBe("2026-11-12T09:05:00.000Z");   // a failed attempt is not an update
});

it("turns a module's automatic update on and off, refuses what it does not know, and says plainly when Docker control is off", async () => {
  await helper({ servers: THREE, updates: {} });
  expect((await request(app).put("/api/admin/modules/prowlarr/auto").set(auth(member.token)).send({ enabled: true })).status).toBe(403);
  expect((await request(app).put("/api/admin/modules/prowlarr/auto").set(auth(admin.token)).send({ enabled: "yes" })).status).toBe(400);
  expect((await request(app).put("/api/admin/modules/nothing/auto").set(auth(admin.token)).send({ enabled: true })).status).toBe(404);
  expect((await request(app).post("/api/admin/modules/nothing/update").set(auth(admin.token))).status).toBe(404);
  const on = await request(app).put("/api/admin/modules/prowlarr/auto").set(auth(admin.token)).send({ enabled: true });
  expect(on.status).toBe(200); expect(on.body.modules.map((one: { name: string; auto: boolean }) => [one.name, one.auto])).toEqual([["prowlarr", true], ["jellyfin", false], ["plex", false]]);
  await sees("Prowlarr updates itself at night", 1);
  expect((await request(app).put("/api/admin/modules/prowlarr/auto").set(auth(admin.token)).send({ enabled: false })).body.modules[0].auto).toBe(false);

  delete process.env.MEDIA_MANAGER_URL; delete process.env.MEDIA_MANAGER_TOKEN; delete process.env.DOCKER_CONTROL_STATE;
  const off = await request(app).get("/api/admin/modules").set(auth(admin.token));
  expect(off.status).toBe(200); expect(off.body.control.mode).toBe("off"); expect(off.body.modules.every((one: { state: string }) => one.state === "unknown")).toBe(true);
  const refused = await request(app).post("/api/admin/modules/prowlarr/update").set(auth(admin.token));
  expect(refused.status).toBe(409); expect(refused.body.error).toMatch(/Docker control/);
});

it("updates the modules that are set to, running, once a night inside its window, and not otherwise", async () => {
  const asked = await helper({ servers: THREE, updates: {} });
  for (const name of ["prowlarr", "plex"]) await request(app).put(`/api/admin/modules/${name}/auto`).set(auth(admin.token)).send({ enabled: true });
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
  const posts = () => asked.filter(line => line.startsWith("POST /servers/"));

  expect(await runAutomaticUpdates(at(12, 12))).toEqual([]); expect(await runAutomaticUpdates(at(12, 2, 59))).toEqual([]); expect(await runAutomaticUpdates(at(12, 5))).toEqual([]);   // outside 03:00 to 05:00
  expect(posts()).toEqual([]);
  expect(await runAutomaticUpdates(at(12, 3, 30))).toEqual(["prowlarr"]);   // plex is set to update itself but is stopped: a stopped module is left as it is
  expect(posts()).toEqual(['POST /servers/prowlarr/update {"apply":true}']);
  await sees("Checking Prowlarr for a newer version (nightly update)", 1);
  expect(await runAutomaticUpdates(at(12, 4, 0))).toEqual([]); expect(posts()).toHaveLength(1);   // once a night
  expect(await runAutomaticUpdates(at(13, 3, 1))).toEqual(["prowlarr"]); expect(posts()).toHaveLength(2);   // and again the next

  await request(app).put("/api/admin/modules/prowlarr/auto").set(auth(admin.token)).send({ enabled: false });
  expect(await runAutomaticUpdates(at(14, 3, 30))).toEqual([]);   // nothing is set to update itself now that plex is stopped and prowlarr is off
  expect(posts()).toHaveLength(2);
});

it("does not use up a night when the helper cannot be reached", async () => {
  const script: Script = { servers: THREE, updates: {} };
  await helper(script); await request(app).put("/api/admin/modules/prowlarr/auto").set(auth(admin.token)).send({ enabled: true });
  const url = process.env.MEDIA_MANAGER_URL!; process.env.MEDIA_MANAGER_URL = "http://127.0.0.1:1";
  expect(await runAutomaticUpdates(new Date(2026, 10, 12, 3, 10))).toEqual([]);
  process.env.MEDIA_MANAGER_URL = url;
  expect(await runAutomaticUpdates(new Date(2026, 10, 12, 3, 40))).toEqual(["prowlarr"]);   // the next try, the same night, goes through
});
