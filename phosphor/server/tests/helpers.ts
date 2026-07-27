import { Express } from "express";
import request from "supertest";
import { createApp } from "../src/app";
import { db } from "../src/db";

export const app: Express = createApp();

/** Wipes every table so each test file starts from a clean slate. */
export async function resetDb(): Promise<void> {
  await db.downloadJob.deleteMany();
  await db.logEvent.deleteMany();
  await db.debridConfig.deleteMany();
  await db.indexerConfig.deleteMany();
  await db.user.deleteMany();
  await db.setting.deleteMany();
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
  const res = await request(app).post("/api/auth/signup").send({ email, password: "password123", displayName: prefix });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.user.id, email };
}

export async function adminAndUser(): Promise<{ admin: TestUser; user: TestUser }> {
  const admin = await signup("admin");
  const user = await signup("user");
  return { admin, user };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
