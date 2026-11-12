import { Express } from "express";
import request from "supertest";
import { createApp } from "../src/app";
import { resetRuntimeSettings } from "../src/runtime-settings";
import { db } from "../src/db";

export const app: Express = createApp();

/** Wipes every table so each test file starts from a clean slate. */
export async function resetDb(): Promise<void> {
  await db.requestEvent.deleteMany();
  await db.requestFollower.deleteMany();
  await db.mediaRequest.deleteMany();
  await db.invitation.deleteMany();
  await db.metadataRecord.deleteMany();
  await db.accountMedia.deleteMany();
  await db.accountScan.deleteMany();
  await db.playbackProgress.deleteMany();
  await db.playbackSession.deleteMany();
  await db.playbackSourceJob.deleteMany();
  await db.favorite.deleteMany();
  await db.playbackLog.deleteMany();
  await db.logEvent.deleteMany();
  await db.profile.deleteMany();
  await db.debridConfig.deleteMany();
  await db.title.deleteMany();
  await db.user.deleteMany();
  await db.setting.deleteMany();
  // Most tests sign people up directly, so they start from a server whose administrator chose open registration.
  // The default (invitation only) is tested in access.test.ts.
  await db.setting.create({ data: { key: "auth.registration", value: JSON.stringify({ mode: "open" }) } });
  resetRuntimeSettings(); // settings saved from Admin → Server are also held in memory
}

export interface TestUser {
  token: string;
  id: string;
  email: string;
}

let counter = 0;

/** Signs up a fresh user. The first signup in an empty DB becomes admin. */
export async function signup(prefix = "user"): Promise<TestUser> {
  const email = `${prefix}-${Date.now()}-${counter++}@test.local`;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "password123", displayName: prefix });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.user.id, email };
}

/** Creates an admin (first user in a clean DB) plus a regular user. */
export async function adminAndUser(): Promise<{ admin: TestUser; user: TestUser }> {
  const admin = await signup("admin");
  const user = await signup("user");
  return { admin, user };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
