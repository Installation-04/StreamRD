import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, adminAndUser } from "./helpers";
import { db } from "../src/db";

beforeEach(async () => { await resetDb(); });
async function seed(count: number) {
  await db.logEvent.deleteMany(); // drop the sign-up events from creating the test users
  const base = Date.parse("2026-01-01T00:00:00Z");
  await db.logEvent.createMany({ data: Array.from({ length: count }, (_, index) => ({
    level: index % 10 === 0 ? "error" : index % 3 === 0 ? "warn" : "info", type: index % 2 ? "playback" : "provider_error",
    message: index === 7 ? "=HYPERLINK(\"http://evil.invalid\")" : index === 8 ? "line one\nline, two \"quoted\"" : `event number ${index}`,
    provider: index % 4 === 0 ? "realdebrid" : null, meta: index === 3 ? JSON.stringify({ libraryId: "lib-1" }) : null, createdAt: new Date(base + index * 1000) })) });
}
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);

it("pages through every log exactly once, newest first, up to 1000 per page", async () => {
  const { admin } = await adminAndUser(); await seed(25);
  const seen: string[] = []; let cursor: string | null = null, pages = 0;
  do {
    const response: request.Response = await request(app).get("/api/admin/logs").query({ limit: 10, ...(cursor ? { cursor } : {}) }).set(auth(admin.token));
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
    seen.push(...ids(response.body.logs)); cursor = response.body.nextCursor; pages++;
  } while (cursor && pages < 10);
  expect(pages).toBe(3); expect(new Set(seen).size).toBe(seen.length); expect(seen.length).toBe(25);
  const all = await request(app).get("/api/admin/logs").query({ limit: 5000 }).set(auth(admin.token));
  expect(all.body.logs).toHaveLength(25); expect(all.body.nextCursor).toBeNull();
  const times = all.body.logs.map((row: { createdAt: string }) => row.createdAt); expect([...times].sort().reverse()).toEqual(times);
});

it("filters by text, level, type, provider and date range, and rejects malformed input", async () => {
  const { admin } = await adminAndUser(); await seed(25);
  const get = (query: Record<string, string>) => request(app).get("/api/admin/logs").query({ limit: 100, ...query }).set(auth(admin.token));
  expect((await get({ q: "event number 1" })).body.logs.length).toBe(11);
  expect((await get({ level: "error" })).body.logs.every((row: { level: string }) => row.level === "error")).toBe(true);
  expect((await get({ type: "playback", provider: "realdebrid" })).body.logs.every((row: { type: string; provider: string }) => row.type === "playback" && row.provider === "realdebrid")).toBe(true);
  const ranged = await get({ from: "2026-01-01T00:00:05Z", to: "2026-01-01T00:00:09Z" });
  expect(ranged.body.logs).toHaveLength(5);
  expect((await get({ from: "not-a-date" })).status).toBe(400);
  expect((await get({ cursor: "!!!" })).status).toBe(400);
  expect((await get({ level: "nonsense" })).body.logs).toEqual([]);
  expect((await get({ type: "x'; DROP TABLE LogEvent;--" })).body.logs).toEqual([]);
  expect(await db.logEvent.count()).toBe(25);
});

it("downloads logs as NDJSON, CSV or text with attachment headers and the same filters", async () => {
  const { admin } = await adminAndUser(); await seed(25);
  const grab = (query: Record<string, string>) => request(app).get("/api/admin/logs/export").query(query).set(auth(admin.token)).buffer(true).parse((res, cb) => { let text = ""; res.setEncoding("utf8"); res.on("data", c => { text += c; }); res.on("end", () => cb(null, text)); });
  const nd = await grab({ format: "ndjson" });
  expect(nd.status).toBe(200); expect(nd.headers["content-disposition"]).toMatch(/^attachment; filename="phosphor-logs-.*\.ndjson"$/); expect(nd.headers["content-type"]).toContain("application/x-ndjson");
  const lines = (nd.body as string).trim().split("\n").map(line => JSON.parse(line));
  expect(lines).toHaveLength(25); expect(lines.find(line => line.message === "event number 3").meta).toEqual({ libraryId: "lib-1" });
  const csv = (await grab({ format: "csv" })).body as string;
  expect(csv.startsWith("time,level,type,provider,userId,message,meta\r\n")).toBe(true);
  expect(csv).toContain("\"'=HYPERLINK(\"\"http://evil.invalid\"\")\""); // formula neutralized, quotes escaped
  expect(csv).toContain("\"line one\nline, two \"\"quoted\"\"\"");
  expect((await grab({ format: "txt" })).headers["content-disposition"]).toContain(".log");
  expect(((await grab({ format: "txt", level: "error" })).body as string).trim().split("\n")).toHaveLength(3);
  expect(((await grab({ format: "ndjson", max: "4" })).body as string).trim().split("\n")).toHaveLength(4);
  expect((await request(app).get("/api/admin/logs/export").query({ format: "xml" }).set(auth(admin.token))).status).toBe(400);
  expect((await request(app).get("/api/admin/logs/export").query({ to: "bad" }).set(auth(admin.token))).status).toBe(400);
});

it("keeps log viewing and export administrator-only", async () => {
  const { user } = await adminAndUser();
  for (const route of ["/api/admin/logs", "/api/admin/logs/export"]) {
    expect((await request(app).get(route)).status).toBe(401);
    expect((await request(app).get(route).set(auth(user.token))).status).toBe(403);
  }
});
