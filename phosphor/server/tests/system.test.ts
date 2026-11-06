import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, adminAndUser } from "./helpers";
import { db } from "../src/db";
import { config } from "../src/config";
import { version } from "../package.json";
const roots = [config.mediaSourceRoot, config.mediaLibraryRoot];
beforeEach(async () => { await resetDb(); });
afterEach(() => { [config.mediaSourceRoot, config.mediaLibraryRoot] = roots; vi.restoreAllMocks(); });
it("requires a live administrator for upgrade diagnostics", async () => {
  const { admin, user } = await adminAndUser();
  expect((await request(app).get("/api/admin/system")).status).toBe(401);
  expect((await request(app).get("/api/admin/system").set(auth(user.token))).status).toBe(403);
  await db.user.update({ where: { id: admin.id }, data: { role: "user" } });
  expect((await request(app).get("/api/admin/system").set(auth(admin.token))).status).toBe(403);
});
it("reports local unmanaged state without changing the database or contacting providers", async () => {
  const { admin } = await adminAndUser();
  config.mediaSourceRoot = "/private/source-mount"; config.mediaLibraryRoot = "/private/export-mount";
  const before = await db.$queryRawUnsafe("SELECT name, sql FROM sqlite_master ORDER BY name");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
  const response = await request(app).get("/api/admin/system").set(auth(admin.token));
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.body.version).toBe(version); expect(response.body.database.status).toBe("up");
  expect(response.body.migrations.state).toBe("unmanaged"); expect(response.body.migrations.applied).toBe(0);
  expect(response.body.upgrade.backupPolicy).toBe("verified-before-changes"); expect(response.body.media.configured).toBe(true);
  expect(JSON.stringify(response.body)).not.toMatch(/private\/source|private\/export|hashedPassword|DATABASE_URL|JWT_SECRET/);
  expect(JSON.stringify(response.body)).not.toContain(config.jwtSecret);
  expect(await db.$queryRawUnsafe("SELECT name, sql FROM sqlite_master ORDER BY name")).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps read-only service failures generic and does not claim schema readiness", async () => {
  const { admin } = await adminAndUser();
  vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error("private-volume-path /secret/password"));
  const response = await request(app).get("/api/admin/system").set(auth(admin.token));
  expect(response.status).toBe(200); expect(response.body.database.status).toBe("down");
  expect(response.body.migrations.state).toBe("unavailable"); expect(JSON.stringify(response.body)).not.toContain("private-volume-path");
});
it("offers a read-only CLI status with a nonzero readiness code for unmanaged databases", async () => {
  const { spawnSync } = await import("node:child_process");
  const before = await db.$queryRawUnsafe("SELECT name, sql FROM sqlite_master ORDER BY name");
  const command = spawnSync(process.execPath, ["scripts/db-status.cjs"], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  expect(command.status).toBe(1); expect(JSON.parse(command.stdout).state).toBe("unmanaged");
  expect(await db.$queryRawUnsafe("SELECT name, sql FROM sqlite_master ORDER BY name")).toEqual(before);
});
