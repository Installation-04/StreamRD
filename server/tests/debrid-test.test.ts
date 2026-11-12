import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, signup } from "./helpers";
import { db } from "../src/db";

beforeEach(async () => { await resetDb(); });
afterEach(() => { vi.unstubAllGlobals(); });
const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))));

it("explains a failed connection test in plain words, never with the provider's code, and never as a 401", async () => {
  const user = await signup("owner");
  await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "a-private-key-that-must-not-leak" });
  const test = () => request(app).get("/api/debrid/account").query({ provider: "realdebrid" }).set(auth(user.token));

  answer(401, { error: "bad_token", error_code: 8 });
  const refused = await test();
  expect(refused.status).toBe(409);            // 401 from this API means the viewer's own session ended
  expect(refused.body.error).toBe("Real-Debrid did not accept this key. Copy it again from your Real-Debrid account, save, and test again.");

  answer(429, { error: "too_many_requests" });
  const limited = await test(); expect(limited.status).toBe(429); expect(limited.body.error).toMatch(/Real-Debrid is limiting requests/);

  answer(503, { error: "service_unavailable" });
  const down = await test(); expect(down.status).toBe(502); expect(down.body.error).toMatch(/Real-Debrid could not be reached or answered with an error \(503\)/);

  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.real-debrid.com")));
  const offline = await test(); expect(offline.status).toBe(502);
  for (const response of [refused, limited, down, offline]) expect(JSON.stringify(response.body)).not.toMatch(/bad_token|too_many|service_unavailable|ENOTFOUND|a-private-key/);

  const logged = await db.logEvent.findMany({ where: { type: "provider_error", userId: user.id } });
  expect(logged).toHaveLength(4); expect(logged.every(line => line.provider === "realdebrid" && line.level === "warn" && !/a-private-key/.test(line.message))).toBe(true);

  answer(200, { id: 1, username: "someone", email: "someone@example.invalid", type: "premium", premium: 86400, expiration: "2030-01-01T00:00:00.000Z", points: 0 });
  const fine = await test(); expect(fine.status).toBe(200); expect(fine.body.account).toMatchObject({ username: "someone", premium: true });
});
