import { createServer, Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, adminAndUser, TestUser } from "./helpers";
import { db } from "../src/db";
import { checkForUpdates, clearUpdateCache } from "../src/maintenance";
import { loadRuntimeSettings, resetRuntimeSettings, runtime, RUNTIME_SETTINGS_KEY } from "../src/runtime-settings";

// What an administrator does from the web page instead of on the server: settings that were environment variables, and a restart.
const ENV = ["TRANSCODE", "TRANSCODE_VIDEO", "TRANSCODE_MAX", "TRANSCODE_ALLOW_PRIVATE_HOSTS", "LINK_HEALTH", "UPDATE_CHECK", "REQUESTS_AUTO_APPROVE", "ADMIN_RESTART", "MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN"];
const kept: Record<string, string | undefined> = {};
let admin: TestUser, member: TestUser, helper: Server | undefined;
beforeEach(async () => { for (const name of ENV) { kept[name] = process.env[name]; delete process.env[name]; } await resetDb(); ({ admin, user: member } = await adminAndUser()); clearUpdateCache(); });
afterEach(async () => {
  for (const name of ENV) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; }
  vi.restoreAllMocks(); resetRuntimeSettings();
  if (helper) { await new Promise(done => helper!.close(done)); helper = undefined; }
});
const settings = () => request(app).get("/api/admin/system/settings").set(auth(admin.token));
const save = (body: unknown, token = admin.token) => request(app).put("/api/admin/system/settings").set(auth(token)).send(body as object);

it("shows each setting with where its value comes from, and lets the administrator change it without a restart", async () => {
  expect((await request(app).get("/api/admin/system/settings")).status).toBe(401);
  expect((await request(app).get("/api/admin/system/settings").set(auth(member.token))).status).toBe(403);
  expect((await save({ transcode: false }, member.token)).status).toBe(403);
  const first = await settings();
  expect(first.status).toBe(200); expect(first.headers["cache-control"]).toContain("no-store");
  expect(first.body.settings).toEqual({ transcode: true, transcodeVideo: true, transcodeMax: 2, transcodeAllowPrivateHosts: false, linkHealth: true, requestsAutoApprove: true, updateCheck: true });
  expect(new Set(Object.values(first.body.sources))).toEqual(new Set(["default"]));

  process.env.TRANSCODE_MAX = "5"; process.env.LINK_HEALTH = "false";   // an install that set these keeps its behaviour
  const fromEnvironment = await settings();
  expect(fromEnvironment.body.settings).toMatchObject({ transcodeMax: 5, linkHealth: false });
  expect(fromEnvironment.body.sources).toMatchObject({ transcodeMax: "environment", linkHealth: "environment", transcode: "default" });

  const saved = await save({ transcodeMax: 3, linkHealth: true, transcodeVideo: false });
  expect(saved.status).toBe(200); expect(saved.body.changed.sort()).toEqual(["linkHealth", "transcodeMax", "transcodeVideo"]);
  expect(saved.body.settings).toMatchObject({ transcodeMax: 3, linkHealth: true, transcodeVideo: false, transcode: true });
  expect(saved.body.sources).toMatchObject({ transcodeMax: "saved", linkHealth: "saved", transcodeVideo: "saved", transcode: "default" });
  expect(runtime()).toMatchObject({ transcodeMax: 3, linkHealth: true, transcodeVideo: false });   // in force at once

  const same = await save({ transcodeMax: 3 }); expect(same.body.changed).toEqual([]);
  const forgotten = await save({ transcodeMax: null });   // forget the saved choice: the environment applies again
  expect(forgotten.body.settings.transcodeMax).toBe(5); expect(forgotten.body.sources.transcodeMax).toBe("environment");

  for (const bad of [{ transcodeMax: 0 }, { transcodeMax: 9 }, { transcodeMax: "2" }, { transcode: "yes" }, { unknown: true }, []]) expect((await save(bad)).status, JSON.stringify(bad)).toBe(400);
  await new Promise(done => setTimeout(done, 100));
  const logged = await db.logEvent.findMany({ where: { type: "admin_action", message: "Changed server settings" }, orderBy: { createdAt: "asc" } });
  expect(logged).toHaveLength(2); expect(JSON.parse(logged[0].meta!)).toEqual({ changed: { transcodeMax: 3, linkHealth: true, transcodeVideo: false } }); expect(logged[0].userId).toBe(admin.id);
});

it("keeps saved choices across a restart, and ignores a stored value it cannot read", async () => {
  await save({ updateCheck: false, transcodeMax: 4 });
  resetRuntimeSettings(); expect(runtime()).toMatchObject({ updateCheck: true, transcodeMax: 2 });   // a fresh process, before it has loaded
  expect(await loadRuntimeSettings()).toMatchObject({ updateCheck: false, transcodeMax: 4 });
  await db.setting.update({ where: { key: RUNTIME_SETTINGS_KEY }, data: { value: JSON.stringify({ transcodeMax: 99, updateCheck: "no", linkHealth: false }) } });
  expect(await loadRuntimeSettings()).toMatchObject({ transcodeMax: 2, updateCheck: true, linkHealth: false });   // only the readable part is used
  await db.setting.update({ where: { key: RUNTIME_SETTINGS_KEY }, data: { value: "not json" } });
  expect(await loadRuntimeSettings()).toMatchObject({ transcodeMax: 2, updateCheck: true, linkHealth: true });
});

it("turns the update check off from the web page: nothing is asked of the release page", async () => {
  const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ tag_name: "v99.0.0", published_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/Installation-04/StreamRD/releases/tag/v99.0.0" }), { status: 200 }));
  expect((await checkForUpdates(true)).updateAvailable).toBe(true); expect(fetched).toHaveBeenCalledTimes(1);
  await save({ updateCheck: false }); clearUpdateCache();
  const off = await checkForUpdates(true);
  expect(off).toMatchObject({ checkEnabled: false, updateAvailable: false, latest: null }); expect(fetched).toHaveBeenCalledTimes(1);
});

const listen = async (answer: (method: string, url: string, authorization: string | undefined) => number) => {
  const seen: string[] = [];
  helper = createServer((req, res) => { seen.push(`${req.method} ${req.url} ${req.headers.authorization}`); const status = answer(req.method!, req.url!, req.headers.authorization); res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(status === 202 ? { restarting: true } : { error: "busy" })); });
  await new Promise<void>(done => helper!.listen(0, "127.0.0.1", done));
  process.env.MEDIA_MANAGER_URL = `http://127.0.0.1:${(helper.address() as { port: number }).port}`; process.env.MEDIA_MANAGER_TOKEN = "t".repeat(40);
  return seen;
};
const maintenance = () => request(app).get("/api/admin/system/maintenance").set(auth(admin.token));
const restart = () => request(app).post("/api/admin/system/restart").set(auth(admin.token));

it("restarts from the web page through the helper, with no supervisor declared, and never by ending the process", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  expect((await maintenance()).body.restartSupported).toBe(false);
  expect((await restart()).status).toBe(409);
  const seen = await listen(() => 202);
  expect((await maintenance()).body.restartSupported).toBe(true);
  const done = await restart(); expect(done.status).toBe(202); expect(done.body).toEqual({ restarting: true });
  expect(seen).toEqual([`POST /restart Bearer ${"t".repeat(40)}`]);
  expect((await request(app).post("/api/admin/system/restart").set(auth(member.token))).status).toBe(403);
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(exit).not.toHaveBeenCalled();   // the helper restarts the container; the process is not asked to end itself
  expect(await db.logEvent.count({ where: { type: "admin_action", message: "Requested a server restart" } })).toBe(1);
});

it("says so when the helper is busy or does not answer, and still ends the process where a supervisor was declared", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await listen(() => 409);
  const busy = await restart(); expect(busy.status).toBe(409); expect(busy.body.error).toMatch(/already restarting or updating/);
  await new Promise(done => helper!.close(done)); helper = undefined;   // the helper is gone
  const gone = await restart(); expect(gone.status).toBe(502); expect(gone.body.error).toMatch(/helper that restarts the server did not answer/);
  expect(exit).not.toHaveBeenCalled();
  delete process.env.MEDIA_MANAGER_URL; delete process.env.MEDIA_MANAGER_TOKEN; process.env.ADMIN_RESTART = "true";
  expect((await restart()).status).toBe(202);
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(exit).toHaveBeenCalledWith(0);
});
