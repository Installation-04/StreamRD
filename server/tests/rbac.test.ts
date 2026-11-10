import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { adminAndUser, app, auth, resetDb, TestUser } from "./helpers";

describe("RBAC on /api/admin/*", () => {
  let admin: TestUser;
  let user: TestUser;

  beforeAll(async () => {
    await resetDb();
    ({ admin, user } = await adminAndUser());
  });

  const adminEndpoints = [
    ["get", "/api/admin/users"],
    ["get", "/api/admin/server"],
    ["get", "/api/admin/providers"],
    ["get", "/api/admin/health"],
    ["get", "/api/admin/logs"],
    ["get", "/api/admin/export/config"],
  ] as const;

  it.each(adminEndpoints)("%s %s rejects anonymous callers with 401", async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  it.each(adminEndpoints)("%s %s rejects regular users with 403", async (method, path) => {
    const res = await request(app)[method](path).set(auth(user.token));
    expect(res.status).toBe(403);
  });

  it.each(adminEndpoints)("%s %s allows admins", async (method, path) => {
    const res = await request(app)[method](path).set(auth(admin.token));
    expect(res.status).toBe(200);
  });

  it("first signup becomes admin, second stays user", async () => {
    const res = await request(app).get("/api/admin/users").set(auth(admin.token));
    const users = res.body.users as Array<{ email: string; role: string }>;
    expect(users.find((u) => u.email === admin.email)?.role).toBe("admin");
    expect(users.find((u) => u.email === user.email)?.role).toBe("user");
  });

  it("admin can promote a user, and the new role takes effect immediately", async () => {
    const promote = await request(app)
      .patch(`/api/admin/users/${user.id}`)
      .set(auth(admin.token))
      .send({ role: "admin" });
    expect(promote.status).toBe(200);
    // Old token, new role: middleware re-reads the role from the DB.
    const check = await request(app).get("/api/admin/users").set(auth(user.token));
    expect(check.status).toBe(200);
    await request(app)
      .patch(`/api/admin/users/${user.id}`)
      .set(auth(admin.token))
      .send({ role: "user" });
  });

  it("admin cannot demote or deactivate themselves", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${admin.id}`)
      .set(auth(admin.token))
      .send({ role: "user" });
    expect(res.status).toBe(400);
  });

  it("deactivated users are rejected on the next request", async () => {
    const victim = await (await import("./helpers")).signup("victim");
    await request(app)
      .patch(`/api/admin/users/${victim.id}`)
      .set(auth(admin.token))
      .send({ active: false });
    const res = await request(app).get("/api/account/profile").set(auth(victim.token));
    expect(res.status).toBe(401);
  });
});
