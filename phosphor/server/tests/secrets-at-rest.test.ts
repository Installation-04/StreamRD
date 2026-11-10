import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, signup } from "./helpers";
import { db, encryptStoredSecrets } from "../src/db";
import { decryptSecret, encryptSecret, isEncrypted } from "../src/crypto";

beforeEach(async () => { await resetDb(); });
const rawKeys = () => db.$queryRawUnsafe<Array<{ realDebridToken: string | null; allDebridApiKey: string | null }>>("SELECT realDebridToken, allDebridApiKey FROM DebridConfig");

it("round-trips, never double-encrypts and rejects tampered or foreign values", () => {
  const stored = encryptSecret("rd-token-1234567890");
  expect(isEncrypted(stored)).toBe(true);
  expect(stored).not.toContain("rd-token");
  expect(encryptSecret(stored)).toBe(stored);
  expect(encryptSecret("rd-token-1234567890")).not.toBe(stored); // a fresh random IV every time
  expect(decryptSecret(stored)).toBe("rd-token-1234567890");
  expect(decryptSecret("legacy-plaintext")).toBe("legacy-plaintext");
  expect(decryptSecret(null)).toBeNull();
  expect(encryptSecret("")).toBe("");
  const tampered = stored.slice(0, -2) + (stored.endsWith("AA") ? "BB" : "AA");
  expect(decryptSecret(tampered)).toBeNull();
  expect(decryptSecret("enc:v1:not-valid")).toBeNull();
});

it("stores debrid keys encrypted but serves them decrypted, including inside transactions", async () => {
  const user = await signup("keys");
  const saved = await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: "RDTOKEN-abcdef1234", allDebridApiKey: "ADKEY-zyxw9876" });
  expect(saved.status).toBe(200);
  const [row] = await rawKeys();
  expect(row.realDebridToken).toMatch(/^enc:v1:/); expect(row.allDebridApiKey).toMatch(/^enc:v1:/);
  expect(JSON.stringify(row)).not.toContain("RDTOKEN"); expect(JSON.stringify(row)).not.toContain("ADKEY");
  const hints = await request(app).get("/api/account/debrid").set(auth(user.token));
  expect(hints.body.keys).toMatchObject({ realdebrid: "****1234", alldebrid: "****9876", premiumize: null });
  expect((await db.debridConfig.findUnique({ where: { userId: user.id }, select: { realDebridToken: true } }))?.realDebridToken).toBe("RDTOKEN-abcdef1234");
  await db.$transaction(async tx => {
    await tx.debridConfig.update({ where: { userId: user.id }, data: { premiumizeApiKey: "PMKEY-0000aaaa" } });
    expect((await tx.debridConfig.findUnique({ where: { userId: user.id } }))?.premiumizeApiKey).toBe("PMKEY-0000aaaa");
  });
  // Clearing and replacing still work.
  await request(app).put("/api/account/debrid").set(auth(user.token)).send({ realDebridToken: null, allDebridApiKey: "NEWKEY-5555" });
  const after = await rawKeys();
  expect(after[0].realDebridToken).toBeNull();
  expect(decryptSecret(after[0].allDebridApiKey!)).toBe("NEWKEY-5555");
});

it("encrypts plaintext credentials left by earlier versions, once", async () => {
  const user = await signup("legacy");
  await db.$executeRawUnsafe("INSERT OR REPLACE INTO DebridConfig (userId, realDebridToken, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)", user.id, "LEGACY-PLAINTEXT-9999");
  expect((await rawKeys())[0].realDebridToken).toBe("LEGACY-PLAINTEXT-9999");
  expect(await encryptStoredSecrets()).toBe(1);
  const [row] = await rawKeys();
  expect(row.realDebridToken).toMatch(/^enc:v1:/);
  expect(decryptSecret(row.realDebridToken!)).toBe("LEGACY-PLAINTEXT-9999");
  expect(await encryptStoredSecrets()).toBe(0);
  expect((await db.debridConfig.findUnique({ where: { userId: user.id } }))?.realDebridToken).toBe("LEGACY-PLAINTEXT-9999");
});

it("encrypts indexer API keys at rest and returns them in clear to the search code", async () => {
  const created = await db.indexerConfig.create({ data: { name: "Fixture", baseUrl: "http://indexer.test/api", apiKey: "INDEXER-SECRET-0001" } });
  const raw = await db.$queryRawUnsafe<Array<{ apiKey: string }>>("SELECT apiKey FROM IndexerConfig");
  expect(raw[0].apiKey).toMatch(/^enc:v1:/); expect(raw[0].apiKey).not.toContain("INDEXER-SECRET");
  expect((await db.indexerConfig.findUnique({ where: { id: created.id } }))?.apiKey).toBe("INDEXER-SECRET-0001");
  await db.indexerConfig.update({ where: { id: created.id }, data: { apiKey: "ROTATED-0002" } });
  expect((await db.indexerConfig.findMany())[0].apiKey).toBe("ROTATED-0002");
  await db.$executeRawUnsafe("UPDATE IndexerConfig SET apiKey = ?", "LEGACY-INDEXER-KEY");
  expect(await encryptStoredSecrets()).toBe(1);
  expect((await db.indexerConfig.findMany())[0].apiKey).toBe("LEGACY-INDEXER-KEY");
});

it("keeps the qBittorrent password encrypted in settings and migrates a plaintext one", async () => {
  await db.setting.upsert({ where: { key: "requests.qbit" }, create: { key: "requests.qbit", value: JSON.stringify({ enabled: false, baseUrl: "", username: "admin", password: "QBIT-PLAIN-PASSWORD", ownerId: "" }) }, update: {} });
  expect(await encryptStoredSecrets()).toBe(1);
  const stored = (await db.setting.findUnique({ where: { key: "requests.qbit" } }))!.value;
  expect(stored).not.toContain("QBIT-PLAIN-PASSWORD"); expect(stored).toContain("enc:v1:");
  const { getRequestSettings } = await import("../src/requests/config");
  expect((await getRequestSettings()).qbit.password).toBe("QBIT-PLAIN-PASSWORD");
  expect(await encryptStoredSecrets()).toBe(0);
});
