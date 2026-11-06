import request from "supertest";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { app, auth, resetDb } from "./helpers";
import { signSession, verifySession } from "../src/auth/jwt";
import { jwtSecretFor } from "../src/auth/secret";
import { config } from "../src/config";
const originalAdmin = config.adminEmail;
beforeEach(async () => { await resetDb(); config.adminEmail = ""; });
afterEach(() => { config.adminEmail = originalAdmin; vi.restoreAllMocks(); });
const signup = (email: string) => request(app).post("/api/auth/signup").send({ email, password: "password123", displayName: "Security fixture" });
const login = (email: string, password = "password123") => request(app).post("/api/auth/login").send({ email, password });
it("enforces production signing secrets and avoids a shared development fallback", () => {
  for (const secret of [undefined, "short", " ".repeat(40), "change-me-to-a-long-random-string"]) expect(() => jwtSecretFor("production", secret)).toThrow("JWT_SECRET");
  const secret = "a-random-looking-production-key-of-at-least-32-bytes";
  expect(jwtSecretFor("production", secret)).toBe(secret);
  expect(jwtSecretFor("development")).not.toBe(jwtSecretFor("development"));
});
it("pins JWT algorithm/issuer and validates claim types", () => {
  const valid = signSession({ sub: "user", email: "user@test.local", role: "user" });
  expect(verifySession(valid)?.version).toBe(0);
  expect(verifySession(valid)?.jti).toBeTypeOf("string");
  for (const [algorithm, issuer, payload] of [
    ["HS384", "phosphor", { sub: "user", email: "u@test.local", role: "user", version: 0 }],
    ["HS256", "other-product", { sub: "user", email: "u@test.local", role: "user", version: 0 }],
    ["HS256", "phosphor", { sub: "user", email: 123, role: "user", version: 0 }],
  ] as const) expect(verifySession(jwt.sign(payload, config.jwtSecret, { algorithm, issuer, expiresIn: "1h", jwtid: "fixture" }))).toBeNull();
});
it("revokes only the signed-out token, durably", async () => {
  const first = await signup("logout@test.local"); const second = await login("logout@test.local");
  expect((await request(app).post("/api/auth/logout").set(auth(first.body.token))).status).toBe(200);
  expect((await request(app).get("/api/account/profile").set(auth(first.body.token))).status).toBe(401);
  expect((await request(app).get("/api/account/profile").set(auth(second.body.token))).status).toBe(200);
  expect(await db.revokedSession.count()).toBe(1);
  expect((await request(app).post("/api/auth/logout")).body).toEqual({ ok: true });
});
it("invalidates old sessions after password changes and issues a current replacement", async () => {
  const first = await signup("password@test.local"); const second = await login("password@test.local");
  const changed = await request(app).post("/api/account/change-password").set(auth(first.body.token)).send({ currentPassword: "password123", newPassword: "replacement123" });
  expect(changed.status).toBe(200); expect(changed.body.token).toBeTypeOf("string");
  for (const token of [first.body.token, second.body.token]) expect((await request(app).get("/api/account/profile").set(auth(token))).status).toBe(401);
  const profile = await request(app).get("/api/account/profile").set(auth(changed.body.token));
  expect(profile.status).toBe(200); expect(profile.body.user.sessionVersion).toBeUndefined();
  expect((await login("password@test.local")).status).toBe(401); expect((await login("password@test.local", "replacement123")).status).toBe(200);
});
it("gives concurrent first signups exactly one bootstrap admin", async () => {
  const results = await Promise.all([signup("race-a@test.local"), signup("race-b@test.local"), signup("race-c@test.local")]);
  expect(results.map(result => result.status)).toEqual([201, 201, 201]);
  expect(results.filter(result => result.body.user.role === "admin")).toHaveLength(1);
});
it("returns a safe conflict for duplicate concurrent signups", async () => {
  const results = await Promise.all([signup("duplicate@test.local"), signup("duplicate@test.local")]);
  expect(results.map(result => result.status).sort()).toEqual([201, 409]);
  expect(JSON.stringify(results.map(result => result.body))).not.toContain("Prisma");
});
it("reserves configured admin email rather than granting the first stranger admin", async () => {
  config.adminEmail = "owner@test.local";
  expect((await signup("stranger@test.local")).body.user.role).toBe("user");
  expect((await signup("owner@test.local")).body.user.role).toBe("admin");
});
it("handles malformed cookies and JSON bodies without leaking request data", async () => {
  expect((await request(app).get("/api/account/profile").set("Cookie", "ph_token=%E0%A4%A")).status).toBe(401);
  const bad = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send('{"password":"fixture-sensitive"');
  expect(bad.status).toBe(400); expect(bad.body.error).toBe("Invalid JSON body");
  expect(bad.body.requestId).toBeTypeOf("string"); expect(JSON.stringify(bad.body)).not.toContain("fixture-sensitive");
});
it("catches rejected route handlers and logs only safe request context", async () => {
  const user = await db.user.create({ data: { email: "error@test.local", displayName: "Error", hashedPassword: "not-for-login" } });
  const token = signSession({ sub: user.id, email: user.email, role: "user" });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(db.user, "findUnique").mockRejectedValueOnce(new Error("fixture-sensitive database detail"));
  const result = await request(app).get("/api/account/profile?apiKey=fixture-sensitive").set(auth(token));
  expect(result.status).toBe(500); expect(result.body.error).toBe("Internal server error");
  expect(result.headers["x-request-id"]).toBe(result.body.requestId);
  expect(JSON.stringify(result.body)).not.toContain("fixture-sensitive"); expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-sensitive");
});
it("catches rejected authentication middleware without an unhandled rejection", async () => {
  const user = await db.user.create({ data: { email: "middleware@test.local", displayName: "Middleware", hashedPassword: "not-for-login" } });
  const token = signSession({ sub: user.id, email: user.email, role: "user" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(db.user, "findFirst").mockRejectedValueOnce(new Error("fixture-sensitive"));
  const result = await request(app).get("/api/account/profile").set(auth(token));
  expect(result.status).toBe(500); expect(result.body.error).toBe("Internal server error");
});

it("deactivation revokes sessions even if the account is later reactivated", async () => {
  const admin = await signup("deactivate-admin@test.local"), user = await signup("deactivate-user@test.local");
  await request(app).patch(`/api/admin/users/${user.body.user.id}`).set(auth(admin.body.token)).send({ active: false });
  await request(app).patch(`/api/admin/users/${user.body.user.id}`).set(auth(admin.body.token)).send({ active: true });
  expect((await request(app).get("/api/account/profile").set(auth(user.body.token))).status).toBe(401);
  expect((await login("deactivate-user@test.local")).status).toBe(200);
});
