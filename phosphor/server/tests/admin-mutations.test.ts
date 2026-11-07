import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { signSession, verifySession } from "../src/auth/jwt";
import { app, auth, resetDb } from "./helpers";

async function user(name: string, role: "admin" | "user") {
  const row = await db.user.create({ data: { email: `${name}@admin-race.test`, displayName: name, role, hashedPassword: "fixture-no-password-login" } });
  return { ...row, token: signSession({ sub: row.id, email: row.email, role }) };
}
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** Pause after middleware has read its actor snapshot, before the route runs. */
function holdAuthenticatedReads(count: number) {
  let entered = 0, started!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  const read = db.user.findFirst.bind(db.user);
  const spy = vi.spyOn(db.user, "findFirst").mockImplementation(args => {
    const pending = read(args);
    return pending.then(async result => { if (++entered === count) started(); await release; return result; }) as typeof pending;
  });
  return { ready, release: () => { spy.mockRestore(); resume(); } };
}

it.each(["demote", "deactivate"] as const)("serializes administrators concurrently attempting to %s one another", async change => {
  const first = await user("first", "admin"), second = await user("second", "admin");
  const barrier = holdAuthenticatedReads(2);
  const patch = change === "demote" ? { role: "user" } : { active: false };
  const responses = [
    request(app).patch(`/api/admin/users/${second.id}`).set(auth(first.token)).send(patch).then(result => result),
    request(app).patch(`/api/admin/users/${first.id}`).set(auth(second.token)).send(patch).then(result => result),
  ];
  await barrier.ready; barrier.release();
  const results = await Promise.all(responses);
  expect(results.filter(result => result.status === 200)).toHaveLength(1);
  expect([401, 403]).toContain(results.find(result => result.status !== 200)!.status);
  expect(await db.user.count({ where: { active: true, role: "admin" } })).toBe(1);
});

it.each(["role", "active", "version", "session"] as const)("rejects a user update when the actor's %s changes after middleware authentication", async change => {
  const actor = await user("actor", "admin"), target = await user("target", "user");
  const barrier = holdAuthenticatedReads(1);
  const running = request(app).patch(`/api/admin/users/${target.id}`).set(auth(actor.token)).send({ role: "admin", displayName: "Unauthorized change" }).then(result => result);
  await barrier.ready;
  if (change === "role") await db.user.update({ where: { id: actor.id }, data: { role: "user" } });
  if (change === "active") await db.user.update({ where: { id: actor.id }, data: { active: false } });
  if (change === "version") await db.user.update({ where: { id: actor.id }, data: { sessionVersion: { increment: 1 } } });
  if (change === "session") {
    const session = verifySession(actor.token)!;
    await db.revokedSession.create({ data: { id: session.jti, userId: actor.id, expiresAt: new Date(session.exp * 1000) } });
  }
  barrier.release();
  const result = await running;
  expect(result.status).toBe(change === "role" ? 403 : 401);
  expect(await db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ role: "user", displayName: "target" });
  expect(await db.logEvent.count({ where: { type: "admin_action" } })).toBe(0);
});

it("retains self-protection and target-not-found behavior", async () => {
  const owner = await user("owner", "admin");
  for (const patch of [{ role: "user" }, { active: false }]) {
    expect((await request(app).patch(`/api/admin/users/${owner.id}`).set(auth(owner.token)).send(patch)).status).toBe(400);
  }
  expect((await request(app).patch("/api/admin/users/missing").set(auth(owner.token)).send({ displayName: "No user" })).status).toBe(404);
  expect(await db.user.count({ where: { active: true, role: "admin" } })).toBe(1);
});
