import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, adminAndUser } from "./helpers";
import { db } from "../src/db";
import { isNewer, clearUpdateCache, listBackups } from "../src/maintenance";
import { version } from "../package.json";

const root = path.resolve(__dirname, "..");
const { applyPendingRestore } = require("../scripts/migrate-db.cjs") as { applyPendingRestore: (o: { root: string; url: string }) => Promise<{ restored: string } | null> };
const url = () => process.env.DATABASE_URL!;
const databaseDir = () => path.dirname(url().replace(/^file:/, ""));
beforeEach(async () => { await resetDb(); clearUpdateCache(); delete process.env.UPDATE_WEBHOOK_URL; delete process.env.UPDATE_WEBHOOK_TOKEN; delete process.env.ADMIN_RESTART; delete process.env.UPDATE_CHECK; });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(path.join(databaseDir(), "backups"), { recursive: true, force: true }); fs.rmSync(path.join(databaseDir(), "restore-pending.json"), { force: true }); delete process.env.UPDATE_WEBHOOK_URL; delete process.env.UPDATE_WEBHOOK_TOKEN; delete process.env.ADMIN_RESTART; });

it("requires a live administrator for every maintenance route", async () => {
  const { user } = await adminAndUser();
  for (const [method, route] of [["get", "/maintenance"], ["post", "/backups"], ["get", "/update"], ["post", "/update"], ["post", "/restart"], ["delete", "/restore"]] as const) {
    expect((await request(app)[method](`/api/admin/system${route}`)).status).toBe(401);
    expect((await request(app)[method](`/api/admin/system${route}`).set(auth(user.token))).status).toBe(403);
  }
});

it("creates verified backups, lists and downloads them, and rejects unsafe names", async () => {
  const { admin } = await adminAndUser();
  const created = await request(app).post("/api/admin/system/backups").set(auth(admin.token));
  expect(created.status).toBe(201); expect(created.body.backup.name).toMatch(/^manual-.*\.db$/);
  const listed = await request(app).get("/api/admin/system/maintenance").set(auth(admin.token));
  expect(listed.body.backups.map((b: { name: string }) => b.name)).toContain(created.body.backup.name);
  expect(listed.body.restartSupported).toBe(false); expect(JSON.stringify(listed.body)).not.toContain(databaseDir());
  const download = await request(app).get(`/api/admin/system/backups/${created.body.backup.name}/download`).set(auth(admin.token)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
  expect(download.status).toBe(200); expect((download.body as Buffer).subarray(0, 15).toString()).toBe("SQLite format 3");
  for (const bad of ["..%2F..%2Fetc%2Fpasswd", "not-a-db.txt", "%2e%2e", "manual-missing.db"]) {
    for (const [method, suffix] of [["get", "/download"], ["post", "/verify"], ["delete", ""]] as const)
      expect([404, 400]).toContain((await request(app)[method](`/api/admin/system/backups/${bad}${suffix}`).set(auth(admin.token))).status);
  }
  expect((await request(app).post(`/api/admin/system/backups/${created.body.backup.name}/verify`).set(auth(admin.token))).body.ok).toBe(true);
  expect((await request(app).delete(`/api/admin/system/backups/${created.body.backup.name}`).set(auth(admin.token))).status).toBe(200);
  expect(listBackups()).toHaveLength(0);
});

it("stages a restore behind an explicit confirmation, keeps a safety backup and swaps the file only at startup", async () => {
  const { admin, user } = await adminAndUser();
  const backup = (await request(app).post("/api/admin/system/backups").set(auth(admin.token))).body.backup.name as string;
  await db.setting.create({ data: { key: "after-backup", value: "1" } });
  const refused = await request(app).post(`/api/admin/system/backups/${backup}/restore`).set(auth(admin.token)).send({ confirm: "yes" });
  expect(refused.status).toBe(400); expect(fs.existsSync(path.join(databaseDir(), "restore-pending.json"))).toBe(false);
  const staged = await request(app).post(`/api/admin/system/backups/${backup}/restore`).set(auth(admin.token)).send({ confirm: "RESTORE" });
  expect(staged.status).toBe(202); expect(staged.body.restartRequired).toBe(true); expect(staged.body.restarting).toBe(false);
  expect(staged.body.preRestoreBackup.name).toMatch(/^pre-restore-/);
  expect((await request(app).get("/api/admin/system/maintenance").set(auth(admin.token))).body.pendingRestore.backup).toBe(backup);
  expect((await request(app).post(`/api/admin/system/backups/${backup}/restore`).set(auth(admin.token)).send({ confirm: "RESTORE" })).status).toBe(409);
  expect((await request(app).delete(`/api/admin/system/backups/${backup}`).set(auth(admin.token))).status).toBe(409);
  // The running database is untouched until the next start.
  expect(await db.setting.count({ where: { key: "after-backup" } })).toBe(1);
  await db.$disconnect(); // the server is restarting; no writer has the file open
  expect(await applyPendingRestore({ root, url: url() })).toEqual({ restored: backup });
  const reopened = new PrismaClient({ datasources: { db: { url: url() } } });
  try {
    expect(await reopened.setting.count({ where: { key: "after-backup" } })).toBe(0);
    expect(await reopened.user.count({ where: { id: { in: [admin.id, user.id] } } })).toBe(2);
  } finally { await reopened.$disconnect(); }
  expect(fs.existsSync(path.join(databaseDir(), "restore-pending.json"))).toBe(false);
  expect(await applyPendingRestore({ root, url: url() })).toBeNull();
});

it("refuses a restore marker that names a missing or unsafe backup without touching the database", async () => {
  await adminAndUser();
  const marker = path.join(databaseDir(), "restore-pending.json"), before = fs.readFileSync(url().replace(/^file:/, ""));
  for (const backup of ["../../etc/passwd", "manual-missing.db", 7]) {
    fs.writeFileSync(marker, JSON.stringify({ backup }));
    await expect(applyPendingRestore({ root, url: url() })).rejects.toMatchObject({ code: expect.stringMatching(/^restore-/) });
    expect(fs.readFileSync(url().replace(/^file:/, ""))).toEqual(before);
  }
});

it("cancels a staged restore and only restarts when the operator declared a supervisor", async () => {
  const { admin } = await adminAndUser();
  const backup = (await request(app).post("/api/admin/system/backups").set(auth(admin.token))).body.backup.name as string;
  await request(app).post(`/api/admin/system/backups/${backup}/restore`).set(auth(admin.token)).send({ confirm: "RESTORE" });
  expect((await request(app).delete("/api/admin/system/restore").set(auth(admin.token))).body.cancelled).toBe(true);
  expect((await request(app).delete("/api/admin/system/restore").set(auth(admin.token))).body.cancelled).toBe(false);
  expect((await request(app).post("/api/admin/system/restart").set(auth(admin.token))).status).toBe(409);
});

it("compares versions strictly and ignores malformed release tags", () => {
  expect(isNewer("0.9.0", "0.8.0")).toBe(true); expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("0.8.0", "0.8.0")).toBe(false); expect(isNewer("0.7.9", "0.8.0")).toBe(false);
  expect(isNewer("latest", "0.8.0")).toBe(false); expect(isNewer("1.0.0-rc.1", "0.8.0")).toBe(false);
});

const release = (tag: string) => new Response(JSON.stringify({ tag_name: tag, published_at: "2026-11-10T00:00:00Z", html_url: "https://github.com/Installation-04/StreamRD/releases/tag/" + tag }), { status: 200 });
it("checks the latest release without requiring a hook, and can be disabled", async () => {
  const { admin } = await adminAndUser();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => release("v99.0.0"));
  const info = (await request(app).get("/api/admin/system/update").set(auth(admin.token))).body;
  expect(info).toMatchObject({ current: version, latest: "99.0.0", updateAvailable: true, canApply: false, checkEnabled: true });
  expect(String(fetch.mock.calls[0][0])).toBe("https://api.github.com/repos/Installation-04/StreamRD/releases/latest");
  process.env.UPDATE_CHECK = "false"; fetch.mockClear();
  expect((await request(app).get("/api/admin/system/update?refresh=1").set(auth(admin.token))).body).toMatchObject({ checkEnabled: false, latest: null, updateAvailable: false });
  expect(fetch).not.toHaveBeenCalled();
});

it("fails soft when the release lookup is unavailable and reports no secrets", async () => {
  const { admin } = await adminAndUser();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("token=secret-network-detail"));
  const response = await request(app).get("/api/admin/system/update").set(auth(admin.token));
  expect(response.status).toBe(200); expect(response.body.error).toMatch(/could not be checked/); expect(JSON.stringify(response.body)).not.toContain("secret-network-detail");
});

it("backs up first and then asks only the operator-configured hook to update", async () => {
  const { admin } = await adminAndUser();
  const noHook = await request(app).post("/api/admin/system/update").set(auth(admin.token)).send({ version: "99.0.0" });
  expect(noHook.status).toBe(409); expect(listBackups()).toHaveLength(0);
  process.env.UPDATE_WEBHOOK_URL = "https://updater.example.invalid/hook"; process.env.UPDATE_WEBHOOK_TOKEN = "hook-token";
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => { calls.push([String(input), init]); return String(input).includes("api.github.com") ? release("v99.0.0") : new Response("ok", { status: 200 }); });
  expect((await request(app).post("/api/admin/system/update").set(auth(admin.token)).send({ version: "98.0.0" })).status).toBe(409);
  expect((await request(app).post("/api/admin/system/update").set(auth(admin.token)).send({ version: "99.0.0; rm -rf" })).status).toBe(400);
  expect(listBackups()).toHaveLength(0);
  const ok = await request(app).post("/api/admin/system/update").set(auth(admin.token)).send({ version: "99.0.0" });
  expect(ok.status).toBe(202); expect(ok.body.backup.name).toMatch(/^pre-update-/); expect(listBackups().some(b => b.kind === "pre-update")).toBe(true);
  const hook = calls.find(([target]) => target.startsWith("https://updater.example.invalid"))!;
  expect(hook[1]?.method).toBe("POST"); expect((hook[1]?.headers as Record<string, string>).Authorization).toBe("Bearer hook-token");
  expect(JSON.parse(String(hook[1]?.body))).toEqual({ product: "phosphor", from: version, to: "99.0.0" });
  expect(JSON.stringify(ok.body)).not.toContain("hook-token");
});

it("keeps the safety backup and reports a generic error when the hook rejects the request", async () => {
  const { admin } = await adminAndUser();
  process.env.UPDATE_WEBHOOK_URL = "https://updater.example.invalid/hook";
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("api.github.com") ? release("v99.0.0") : new Response("boom", { status: 500 }));
  const response = await request(app).post("/api/admin/system/update").set(auth(admin.token)).send({ version: "99.0.0" });
  expect(response.status).toBe(502); expect(response.body.error).toMatch(/did not accept/); expect(listBackups().some(b => b.kind === "pre-update")).toBe(true);
});
