import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { accountProviderContext } from "../src/account-library";

let serial = 0;
async function user(role: "admin" | "user" = "user", maxAge: number | null = null) {
  const created = await db.user.create({ data: { email: `homeopt-${serial++}@example.invalid`, displayName: role === "admin" ? "Server owner" : "Family member", hashedPassword: "fixture-no-password-auth", role, maxAge } });
  return { ...created, token: signSession({ sub: created.id, email: created.email, role, version: created.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
async function item(owner: User, name: string, extra: Record<string, unknown> = {}) {
  await db.debridConfig.upsert({ where: { userId: owner.id }, create: { userId: owner.id, realDebridToken: "private-fixture-key" }, update: {} });
  const ctx = await accountProviderContext(owner.id, "realdebrid");
  return db.accountMedia.create({ data: { userId: owner.id, provider: "realdebrid", providerRef: `ref-${serial++}`, credentialFingerprint: ctx.fingerprint, name, year: 2020, type: "movie", phase: "finished", progress: 100, groupKey: `title:${name}`, minAge: 0, ratingLabel: "G", ...extra } });
}
async function library(owner: User, members: User[] = []) {
  const created = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Family movies", mediaType: "movie" });
  expect(created.status).toBe(201);
  for (const member of members) expect((await request(app).post(`/api/admin/shared-libraries/${created.body.library.id}/users`).set(auth(owner.token)).send({ userId: member.id })).status).toBe(200);
  return created.body.library.id as string;
}
beforeEach(async () => { await resetDb(); });
it("lets only an administrator read and change the home page options, and keeps the choice", async () => {
  const admin = await user("admin"), member = await user();
  expect((await request(app).get("/api/admin/home-settings").set(auth(admin.token))).body).toEqual({ autoplayTrailers: false });
  expect((await request(app).get("/api/admin/home-settings").set(auth(member.token))).status).toBe(403);
  expect((await request(app).put("/api/admin/home-settings").set(auth(member.token)).send({ autoplayTrailers: true })).status).toBe(403);
  expect((await request(app).put("/api/admin/home-settings").send({ autoplayTrailers: true })).status).toBe(401);
  expect((await request(app).put("/api/admin/home-settings").set(auth(admin.token)).send({ autoplayTrailers: "yes" })).status).toBe(400);
  expect((await request(app).put("/api/admin/home-settings").set(auth(admin.token)).send({ autoplayTrailers: true, extra: 1 })).status).toBe(400);
  expect((await request(app).put("/api/admin/home-settings").set(auth(admin.token)).send({ autoplayTrailers: true })).body).toEqual({ autoplayTrailers: true });
  expect((await request(app).get("/api/admin/home-settings").set(auth(admin.token))).body).toEqual({ autoplayTrailers: true });
});
