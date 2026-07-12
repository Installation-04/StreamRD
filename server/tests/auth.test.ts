import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { app, auth, resetDb, signup } from "./helpers";

describe("auth & account flows", () => {
  beforeAll(async () => {
    await resetDb();
    await signup("bootstrap-admin"); // consume the first-user-is-admin slot
  });

  it("signup returns a token and never leaks the password hash", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: "carol@test.local",
      password: "password123",
      displayName: "Carol",
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.hashedPassword).toBeUndefined();
    expect(res.body.user.role).toBe("user");
  });

  it("rejects duplicate emails and weak passwords", async () => {
    const dup = await request(app).post("/api/auth/signup").send({
      email: "carol@test.local",
      password: "password123",
      displayName: "Carol again",
    });
    expect(dup.status).toBe(409);
    const weak = await request(app).post("/api/auth/signup").send({
      email: "dave@test.local",
      password: "short",
      displayName: "Dave",
    });
    expect(weak.status).toBe(400);
  });

  it("login works with the right password and fails with the wrong one", async () => {
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email: "carol@test.local", password: "password123" });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email: "carol@test.local", password: "wrong-password" });
    expect(bad.status).toBe(401);
  });

  it("profile requires auth and returns the caller", async () => {
    const anon = await request(app).get("/api/account/profile");
    expect(anon.status).toBe(401);
    const user = await signup("profile");
    const res = await request(app).get("/api/account/profile").set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
  });

  it("change-password verifies the current password and rotates it", async () => {
    const user = await signup("rotate");
    const wrong = await request(app)
      .post("/api/account/change-password")
      .set(auth(user.token))
      .send({ currentPassword: "nope", newPassword: "newpassword123" });
    expect(wrong.status).toBe(403);
    const ok = await request(app)
      .post("/api/account/change-password")
      .set(auth(user.token))
      .send({ currentPassword: "password123", newPassword: "newpassword123" });
    expect(ok.status).toBe(200);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "newpassword123" });
    expect(login.status).toBe(200);
  });

  it("debrid config round-trips and only exposes key hints", async () => {
    const user = await signup("debrid");
    const put = await request(app)
      .put("/api/account/debrid")
      .set(auth(user.token))
      .send({
        primaryProvider: "alldebrid",
        realDebridToken: "rd-secret-token-1234",
        allDebridApiKey: "ad-secret-key-5678",
      });
    expect(put.status).toBe(200);
    const get = await request(app).get("/api/account/debrid").set(auth(user.token));
    expect(get.status).toBe(200);
    expect(get.body.primaryProvider).toBe("alldebrid");
    expect(get.body.keys.realdebrid).toBe("****1234");
    expect(get.body.keys.alldebrid).toBe("****5678");
    expect(get.body.keys.premiumize).toBeNull();
    expect(JSON.stringify(get.body)).not.toContain("rd-secret-token-1234");
  });
});
