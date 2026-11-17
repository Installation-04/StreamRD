import http from "node:http";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, adminAndUser, TestUser } from "./helpers";
import { db } from "../src/db";

// The Docker helper is played by a small server; what is looked at is the labelling, what is kept out, the merge with StreamRD's own event log,
// who may read, and that a name outside the list never reaches the helper.
const ENV = ["MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN", "DOCKER_CONTROL_STATE"];
const kept: Record<string, string | undefined> = {};
let admin: TestUser, member: TestUser, servers: http.Server[] = [];
async function helper() {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`); res.writeHead(200, { "Content-Type": "application/json" });
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/logs/sources") return void res.end(JSON.stringify({ sources: [
      { id: "core:streamrd-api", state: "running", lines: 12 }, { id: "core:qbittorrent", state: "running", lines: 3 }, { id: "app:sonarr", state: "running" }, { id: "app:radarr", state: "absent" },
      { id: "app:plex", state: "stopped" }, { id: "svc:zurg", state: "running" }, { id: "svc:zilean", state: "absent" }, { id: "svc:unknown-thing", state: "running" }, { id: "app:nothing-known", state: "running" }, { id: "sup:tool", label: "The tool", state: "running" }, { id: "sup:gone", state: "running" },
    ] }));
    if (url.pathname === "/logs/read") { const source = url.searchParams.get("source"); return void res.end(JSON.stringify({ source, lines: source === "all"
      ? [{ time: "2026-11-15T10:00:01.000000000Z", source: "svc:zurg", text: "mounted" }, { time: "2026-11-15T10:00:03.000000000Z", source: "core:streamrd-api", text: "listening" }]
      : [{ time: "2026-11-15T10:00:01.000000000Z", source: source!, text: "Mounted /mnt/zurg" }, { time: "2026-11-15T10:00:02.000000000Z", source: source!, text: "ERROR something failed" }] })); }
    res.end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
  Object.assign(process.env, { MEDIA_MANAGER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, MEDIA_MANAGER_TOKEN: "m".repeat(40), DOCKER_CONTROL_STATE: "embedded" });
  return asked;
}
beforeEach(async () => { for (const n of ENV) { kept[n] = process.env[n]; delete process.env[n]; } await resetDb(); ({ admin, user: member } = await adminAndUser()); });
afterEach(async () => { for (const n of ENV) { if (kept[n] === undefined) delete process.env[n]; else process.env[n] = kept[n]; } await Promise.all(servers.splice(0).map(s => new Promise(done => s.close(done)))); });

it("lists what can be read, in plain words and groups, leaving out what is not installed and what it cannot name, for administrators only", async () => {
  await helper();
  expect((await request(app).get("/api/admin/monitor/sources")).status).toBe(401);
  expect((await request(app).get("/api/admin/monitor/sources").set(auth(member.token))).status).toBe(403);
  const found = await request(app).get("/api/admin/monitor/sources").set(auth(admin.token));
  expect(found.status).toBe(200); expect(found.body.note).toBeNull();
  expect(found.body.sources).toEqual([
    { id: "events", label: "StreamRD events", group: "StreamRD", state: "running" },
    { id: "core:streamrd-api", label: "StreamRD server", group: "StreamRD", state: "running", lines: 12 },
    { id: "core:qbittorrent", label: "qBittorrent", group: "StreamRD", state: "running", lines: 3 },
    { id: "app:sonarr", label: "Sonarr", group: "Add-ons", state: "running" },
    { id: "app:plex", label: "Plex", group: "Media servers", state: "stopped" },
    { id: "svc:zurg", label: "Zurg", group: "Services", state: "running" },
    { id: "sup:tool", label: "The tool", group: "Services", state: "running" },   // a program run inside the container; one with no name is left out
  ]);
});

it("reads one program's output, filters it, and merges every program with StreamRD's events for the all view, oldest first", async () => {
  const asked = await helper();
  await db.logEvent.create({ data: { level: "warn", type: "system", message: "Link needs attention: Example", createdAt: new Date("2026-11-15T10:00:02.000Z") } });
  const one = await request(app).get("/api/admin/monitor/logs?source=svc:zurg&tail=50").set(auth(admin.token));
  expect(one.status).toBe(200); expect(one.body.lines.map((line: { text: string }) => line.text)).toEqual(["Mounted /mnt/zurg", "ERROR something failed"]);
  expect(asked).toContain("GET /logs/read?source=svc%3Azurg&tail=50");
  expect((await request(app).get("/api/admin/monitor/logs?source=sup:tool&tail=5").set(auth(admin.token))).status).toBe(200);
  const filtered = await request(app).get("/api/admin/monitor/logs?source=svc:zurg&q=error").set(auth(admin.token));
  expect(filtered.body.lines).toHaveLength(1);
  const all = await request(app).get("/api/admin/monitor/logs?source=all&tail=10").set(auth(admin.token));
  const ours = ["svc:zurg: mounted", "events: [system] Link needs attention: Example", "core:streamrd-api: listening"];   // the test database holds other events too (sign-ups)
  expect(all.body.lines.map((line: { source: string; text: string }) => `${line.source}: ${line.text}`).filter((text: string) => ours.includes(text))).toEqual(ours);
  const events = await request(app).get("/api/admin/monitor/logs?source=events").set(auth(admin.token));
  expect(events.body.lines[0]).toMatchObject({ source: "events", level: "warn" });
  expect((await request(app).get("/api/admin/monitor/logs?source=svc:zurg").set(auth(member.token))).status).toBe(403);
});

it("refuses any name that is not one of the listed kinds before it reaches the helper", async () => {
  const asked = await helper();
  for (const bad of ["svc:", "../x", "svc:Zurg", "svc:zurg;x", "container:zurg", "app:" + "a".repeat(40)]) expect((await request(app).get(`/api/admin/monitor/logs?source=${encodeURIComponent(bad)}`).set(auth(admin.token))).status, bad).toBe(400);
  expect((await request(app).get("/api/admin/monitor/logs?source=all&tail=5000").set(auth(admin.token))).status).toBe(400);
  expect(asked).toEqual([]);
});

it("still shows StreamRD's own events when Docker control is off, and says why the rest is missing", async () => {
  process.env.DOCKER_CONTROL_STATE = "off";
  const found = await request(app).get("/api/admin/monitor/sources").set(auth(admin.token));
  expect(found.body.sources.map((source: { id: string }) => source.id)).toEqual(["events"]); expect(found.body.note).toMatch(/Docker control/);
  expect((await request(app).get("/api/admin/monitor/logs?source=events").set(auth(admin.token))).status).toBe(200);
  expect((await request(app).get("/api/admin/monitor/logs?source=svc:zurg").set(auth(admin.token))).status).toBe(409);
});
