import { createHash } from "node:crypto";
import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { getRequestSettings, qbitContext } from "../src/requests/config";
import { app, auth, resetDb } from "./helpers";

let owner: { id: string; token: string }, other: { id: string; token: string };
const connection = { enabled: true, baseUrl: "http://qbit.fixture.invalid:8080", username: "fixture-admin", password: "private-sharing-password" };
beforeEach(async () => {
  await resetDb();
  const make = async (email: string) => {
    const user = await db.user.create({ data: { email, displayName: "Fixture", hashedPassword: "unused-fixture-hash", role: "admin" } });
    return { id: user.id, token: signSession({ sub: user.id, email, role: "admin" }) };
  };
  owner = await make("share-owner@fixture.invalid"); other = await make("share-other@fixture.invalid");
});
const save = (token: string, qbit: unknown) => request(app).put("/api/admin/request-settings").set(auth(token)).send({ qbit });

it("keeps new connections private until their owner explicitly opts into add-on sharing", async () => {
  const created = await save(owner.token, connection);
  expect(created.status).toBe(200); expect(created.body.settings.qbit.shareWithAddons).toBe(false);
  expect((await getRequestSettings()).qbit.shareWithAddons).toBe(false);
  const enabled = await save(owner.token, { shareWithAddons: true });
  expect(enabled.status).toBe(200); expect(enabled.body.settings.qbit.shareWithAddons).toBe(true);
  expect(JSON.stringify(enabled.body)).not.toContain(connection.password);
  expect((await db.setting.findUniqueOrThrow({ where: { key: "requests.qbit" } })).value).not.toContain(connection.password);
});

it("does not let another administrator opt the private connection into sharing", async () => {
  await save(owner.token, connection);
  expect((await save(other.token, { shareWithAddons: true })).status).toBe(409);
  expect((await getRequestSettings()).qbit.shareWithAddons).toBe(false);
  await save(owner.token, { shareWithAddons: true });
  const hidden = await request(app).get("/api/admin/request-settings").set(auth(other.token));
  expect(hidden.body.settings.qbit).toMatchObject({ shareWithAddons: false, baseUrl: "", username: "", ownedByYou: false });
});

it("defaults legacy settings to private and preserves their exact request fingerprint", async () => {
  const legacy = { ...connection, ownerId: owner.id };
  await db.setting.create({ data: { key: "requests.qbit", value: JSON.stringify(legacy) } });
  const previous = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
  const original = await qbitContext(owner.id);
  expect(original.settings.shareWithAddons).toBe(false); expect(original.fingerprint).toBe(previous);
  await save(owner.token, { shareWithAddons: true });
  expect((await qbitContext(owner.id)).fingerprint).toBe(previous);
  await save(owner.token, { shareWithAddons: false });
  expect((await qbitContext(owner.id)).fingerprint).toBe(previous);
});

it("clears sharing permission when the owner resets the connection", async () => {
  await save(owner.token, { ...connection, shareWithAddons: true });
  const reset = await request(app).post("/api/admin/request-settings/reset").set(auth(owner.token));
  expect(reset.status).toBe(200);
  expect((await getRequestSettings()).qbit).toMatchObject({ enabled: false, password: "", shareWithAddons: false });
});
