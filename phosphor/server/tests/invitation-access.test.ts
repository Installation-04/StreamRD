import request from "supertest";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { config } from "../src/config";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { hashPassword } from "../src/auth/passwords";
import { app, auth, resetDb } from "./helpers";

// An invitation can carry library access and a viewing limit that the new account starts with.
let hash: string, admin: { id: string; token: string }, other: { id: string; token: string };
const originalAdminEmail = config.adminEmail;
beforeAll(async () => { hash = await hashPassword("password123"); });
beforeEach(async () => {
  await resetDb(); config.adminEmail = "";
  const owner = await db.user.create({ data: { email: "owner@invites.test", displayName: "Owner", role: "admin", hashedPassword: hash } });
  const second = await db.user.create({ data: { email: "second@invites.test", displayName: "Second admin", role: "admin", hashedPassword: hash } });
  admin = { id: owner.id, token: signSession({ sub: owner.id, email: owner.email, role: "admin" }) };
  other = { id: second.id, token: signSession({ sub: second.id, email: second.email, role: "admin" }) };
  await request(app).put("/api/admin/access").set(auth(admin.token)).send({ mode: "invite" });
});
afterEach(() => { config.adminEmail = originalAdminEmail; vi.restoreAllMocks(); });
const library = async (name: string, owner = admin) => (await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name, mediaType: "all" })).body.library.id as string;
const invite = (body: Record<string, unknown>) => request(app).post("/api/admin/invitations").set(auth(admin.token)).send({ email: "guest@invites.test", ...body });
const join = (inviteToken: string, email = "guest@invites.test") => request(app).post("/api/auth/signup").send({ email, password: "password123", displayName: "Guest", inviteToken });

it("gives the new account the invited libraries and viewing limit, and only those", async () => {
  const movies = await library("Movies"), shows = await library("TV Shows"), secret = await library("Private");
  const created = await invite({ libraryIds: [movies, shows], maxAge: 8 });
  expect(created.status).toBe(201);
  expect(created.body.invitation).toMatchObject({ status: "pending", libraryIds: [movies, shows], maxAge: 8 });
  // Before signing up, the invited person is told what they will get; nothing else about the server leaks.
  const preview = await request(app).post("/api/auth/invitation").send({ inviteToken: created.body.inviteToken });
  expect(preview.body).toEqual({ email: "guest@invites.test", expiresAt: expect.any(String), libraries: ["Movies", "TV Shows"], limited: true });
  const joined = await join(created.body.inviteToken);
  expect(joined.status).toBe(201); expect(joined.body.user.maxAge).toBe(8);
  const seen = await request(app).get("/api/shared-libraries").set(auth(joined.body.token));
  expect(seen.body.libraries.map((entry: { name: string }) => entry.name).sort()).toEqual(["Movies", "TV Shows"]);   // not "Private"
  expect(await db.sharedLibraryGrant.count({ where: { userId: joined.body.user.id, libraryId: secret } })).toBe(0);
  expect((await request(app).get("/api/admin/invitations").set(auth(admin.token))).body.invitations[0].status).toBe("accepted");
});
it("works as before when an invitation carries no access", async () => {
  const created = await invite({});
  expect(created.body.invitation).toMatchObject({ libraryIds: [], maxAge: null });
  expect((await request(app).post("/api/auth/invitation").send({ inviteToken: created.body.inviteToken })).body).toMatchObject({ libraries: [], limited: false });
  const joined = await join(created.body.inviteToken);
  expect(joined.status).toBe(201); expect(joined.body.user.maxAge).toBeNull();
  expect(await db.sharedLibraryGrant.count({ where: { userId: joined.body.user.id } })).toBe(0);
});
it("refuses libraries the administrator does not manage and viewing limits that are not offered", async () => {
  const mine = await library("Mine"), theirs = await library("Theirs", other);
  expect((await invite({ libraryIds: [mine, theirs] })).status).toBe(400);
  expect((await invite({ libraryIds: ["does-not-exist"] })).status).toBe(400);
  for (const bad of [5, 99, "kids"]) expect((await invite({ maxAge: bad })).status).toBe(400);
  expect((await invite({ libraryIds: Array.from({ length: 21 }, (_, index) => `lib${index}`) })).status).toBe(400);
  expect((await invite({ libraryIds: [mine], maxAge: 17 })).status).toBe(201);
});
it("skips a library that was deleted after the invitation was created, and one use only", async () => {
  const keep = await library("Keep"), gone = await library("Gone");
  const created = await invite({ libraryIds: [keep, gone] });
  await request(app).delete(`/api/admin/shared-libraries/${gone}`).set(auth(admin.token));
  expect((await request(app).post("/api/auth/invitation").send({ inviteToken: created.body.inviteToken })).body.libraries).toEqual(["Keep"]);
  const joined = await join(created.body.inviteToken);
  expect(joined.status).toBe(201);
  expect((await request(app).get("/api/shared-libraries").set(auth(joined.body.token))).body.libraries.map((entry: { name: string }) => entry.name)).toEqual(["Keep"]);
  expect((await join(created.body.inviteToken, "another@invites.test")).status).toBe(400);
});
it("lets an administrator set the address used in invitation links, and nothing else", async () => {
  const put = (url: string | null) => request(app).put("/api/admin/invite-address").set(auth(admin.token)).send({ url });
  expect((await request(app).get("/api/admin/invite-address").set(auth(admin.token))).body).toEqual({ url: null });
  expect((await put("http://192.168.1.20:8080/")).body).toEqual({ url: "http://192.168.1.20:8080" });
  expect((await request(app).get("/api/admin/invite-address").set(auth(admin.token))).body).toEqual({ url: "http://192.168.1.20:8080" });
  expect((await put("https://media.tail1234.ts.net")).body).toEqual({ url: "https://media.tail1234.ts.net" });
  for (const bad of ["javascript:alert(1)", "ftp://host", "http://user:pass@host", "http://host/path", "http://host/?q=1", "http://host/#x", "not a url"]) expect((await put(bad)).status, bad).toBe(400);
  expect((await put(null)).body).toEqual({ url: null });
  const member = await db.user.create({ data: { email: "m@invites.test", displayName: "M", hashedPassword: hash } });
  expect((await request(app).put("/api/admin/invite-address").set(auth(signSession({ sub: member.id, email: member.email, role: "user" }))).send({ url: "http://evil" })).status).toBe(403);
});
