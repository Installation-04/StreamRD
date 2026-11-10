import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, enableWal } from "../src/db";

const originalOrigins = config.corsOrigins;
afterEach(() => { config.corsOrigins = originalOrigins; delete process.env.SQLITE_WAL; });

it("sets conservative security headers on every API response", async () => {
  const response = await request(createApp()).get("/api/health");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["x-frame-options"]).toBe("DENY");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["x-powered-by"]).toBeUndefined();
});
it("allows no cross-origin callers when CORS_ORIGINS is empty, and only the listed ones otherwise", async () => {
  config.corsOrigins = "";
  expect((await request(createApp()).get("/api/health").set("Origin", "http://evil.test")).headers["access-control-allow-origin"]).toBeUndefined();
  config.corsOrigins = "http://app.test, http://other.test";
  const listed = await request(createApp()).get("/api/health").set("Origin", "http://other.test");
  expect(listed.headers["access-control-allow-origin"]).toBe("http://other.test");
  expect((await request(createApp()).get("/api/health").set("Origin", "http://evil.test")).headers["access-control-allow-origin"]).toBeUndefined();
});
it("switches SQLite to write-ahead logging unless disabled", async () => {
  process.env.SQLITE_WAL = "false";
  await enableWal();
  const before = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
  expect(before[0].journal_mode).not.toBe("wal");
  delete process.env.SQLITE_WAL;
  await enableWal();
  const after = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
  expect(after[0].journal_mode).toBe("wal");
  expect((await db.$queryRawUnsafe<Array<{ timeout: bigint }>>("PRAGMA busy_timeout"))[0].timeout).toBeGreaterThanOrEqual(5000n);
});
