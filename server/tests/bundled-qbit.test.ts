import { beforeEach, expect, it } from "vitest";
import { db } from "../src/db";
import { approvedBundledHost, isBundledQbitUrl, validPeerHost } from "../src/bundled-qbit";
import { resetDb } from "./helpers";
let ownerId = "";
beforeEach(async () => { await resetDb(); ownerId = (await db.user.create({ data: { email: "bundled@fixture.invalid", displayName: "Owner", hashedPassword: "fixture", role: "admin" } })).id; });
const policy = () => ({ enabled: true, shareWithAddons: true, allowBundledAccess: true, baseUrl: "http://127.0.0.1:8082", username: "admin", password: "encrypted-fixture", ownerId });
const store = async (patch = {}) => db.setting.create({ data: { key: "requests.qbit", value: JSON.stringify({ ...policy(), ...patch }) } });
it("reads explicit approval without changing saved settings", async () => {
  const original = await store();
  expect(await approvedBundledHost(db, "streamrd-fixture")).toBe("streamrd-fixture");
  expect(await db.setting.findUnique({ where: { key: original.key } })).toEqual(original);
});
it.each([{ enabled: false }, { shareWithAddons: false }, { allowBundledAccess: false }, { allowBundledAccess: "true" }, { baseUrl: "http://other:8082" }, { password: "" }, { ownerId: "missing" }])("keeps access local without valid approval: %j", async patch => {
  await store(patch); expect(await approvedBundledHost(db, "streamrd-fixture")).toBe("");
});
it.each([{ active: false }, { role: "user" }])("requires an active administrator owner: %j", async patch => {
  await store(); await db.user.update({ where: { id: ownerId }, data: patch });
  expect(await approvedBundledHost(db, "streamrd-fixture")).toBe("");
});
it("fails closed for missing or malformed settings", async () => {
  expect(await approvedBundledHost(db, "streamrd-fixture")).toBe("");
  await db.setting.create({ data: { key: "requests.qbit", value: "malformed" } });
  expect(await approvedBundledHost(db, "streamrd-fixture")).toBe("");
});
it.each(["http://127.0.0.1:8082", "http://localhost:8082/"])("recognizes bundled URL %s", value => expect(isBundledQbitUrl(value)).toBe(true));
it.each(["http://127.0.0.1:8080", "https://localhost:8082", "http://localhost:8082/other", "http://user:pass@localhost:8082", "http://localhost:8082?x=1", "http://other:8082", "bad"])("does not rewrite another service: %s", value => expect(isBundledQbitUrl(value)).toBe(false));
it.each(["", "localhost", "bridge", "host", "none", "bad/name", "127.0.0.1", "123", "service.localhost", "x\nInjected=value"])("rejects unsafe peer host %j", host => expect(validPeerHost(host)).toBe(false));
