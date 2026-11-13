import http from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { db } from "../src/db";
import { encryptSecret } from "../src/crypto";
import { ensureDownloadClient } from "../src/addon-links";
import { resetDb } from "./helpers";

const KEY = "addon-api-key-fixture", PASSWORD = "download-client-password-fixture";
let servers: http.Server[] = [], ownerId = "";
const clients: Record<string, unknown>[] = [];
const calls: string[] = [];
const schema = { implementation: "QBittorrent", configContract: "QBittorrentSettings", fields: [
  ...["host", "port", "useSsl", "urlBase", "username", "password", "tvCategory"].map(name => ({ name, value: "" as unknown })),
  { name: "recentTvPriority", value: 2 },
] };
async function settings(patch: Record<string, unknown> = {}) {
  const value = JSON.stringify({ enabled: true, baseUrl: "https://qbit.fixture.invalid:9443/downloader", username: "fixture-admin", password: encryptSecret(PASSWORD), ownerId, shareWithAddons: true, ...patch });
  await db.setting.upsert({ where: { key: "requests.qbit" }, create: { key: "requests.qbit", value }, update: { value } });
}
async function addon(version = "v3", onSchema?: () => Promise<void>, categoryField = "tvCategory") {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => { void (async () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.headers["x-api-key"] !== KEY) return send({}, 401);
      if (req.url === `/api/${version}/downloadclient/schema`) { await onSchema?.(); return send([{ ...schema, fields: schema.fields.map(field => field.name === "tvCategory" ? { ...field, name: categoryField } : field) }]); }
      if (req.url === `/api/${version}/downloadclient` && req.method === "GET") return send(clients);
      if (req.url === `/api/${version}/downloadclient` && req.method === "POST") { const body = JSON.parse(Buffer.concat(chunks).toString()); clients.push(body); return send(body, 201); }
      return send({}, 404);
    })().catch(() => { res.writeHead(500); res.end(); }); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
beforeEach(async () => {
  delete process.env.BUNDLED_QBIT_HOST; delete process.env.BUNDLED_QBIT_ACCESS_ACTIVE;
  await resetDb(); clients.length = 0; calls.length = 0;
  ownerId = (await db.user.create({ data: { email: "download-owner@fixture.invalid", displayName: "Owner", hashedPassword: "unused-fixture-hash", role: "admin" } })).id;
});
afterEach(async () => { delete process.env.BUNDLED_QBIT_HOST; delete process.env.BUNDLED_QBIT_ACCESS_ACTIVE; await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

it.each(["sonarr", "radarr", "lidarr"] as const)("connects %s once using schema defaults and the enabled owner's credentials", async name => {
  const categoryField = { sonarr: "tvCategory", radarr: "movieCategory", lidarr: "musicCategory" }[name];
  await settings(); const base = await addon(name === "lidarr" ? "v1" : "v3", undefined, categoryField);
  expect(await ensureDownloadClient(name, base, KEY)).toBe("set");
  expect(await ensureDownloadClient(name, base, KEY)).toBe("kept");
  expect(clients).toHaveLength(1);
  expect(clients[0]).toMatchObject({ implementation: "QBittorrent", enable: true, protocol: "torrent", removeCompletedDownloads: false, removeFailedDownloads: false });
  const fields = Object.fromEntries((clients[0].fields as { name: string; value: unknown }[]).map(field => [field.name, field.value]));
  expect(fields).toMatchObject({ host: "qbit.fixture.invalid", port: 9443, useSsl: true, urlBase: "/downloader", username: "fixture-admin", password: PASSWORD, [categoryField]: `streamrd-${name}`, recentTvPriority: 2 });
  expect(calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
  expect((await db.setting.findUniqueOrThrow({ where: { key: "requests.qbit" } })).value).not.toContain(PASSWORD);
});

it("preserves a manually configured disabled client without requesting a schema or changing it", async () => {
  await settings(); clients.push({ name: "Owner's client", implementation: "Deluge", enable: false });
  const base = await addon();
  expect(await ensureDownloadClient("sonarr", base, KEY)).toBe("kept");
  expect(clients).toEqual([{ name: "Owner's client", implementation: "Deluge", enable: false }]);
  expect(calls).toEqual(["GET /api/v3/downloadclient"]);
});

it.each(["http://localhost:8082", "http://localhost.:8082", "http://127.1:8082", "http://[::1]:8082", "http://[::ffff:127.0.0.1]:8082", "http://0.0.0.0:8082", "http://[::]:8082"])("does not forward the unusable local address %s to an add-on", async baseUrl => {
  await settings({ baseUrl }); const base = await addon();
  expect(await ensureDownloadClient("sonarr", base, KEY)).toBe("local-only");
  expect(calls).toEqual([]);
});

it("makes no add-on requests when the download client is not configured or is disabled", async () => {
  const base = await addon();
  expect(await ensureDownloadClient("sonarr", base, KEY)).toBe("unconfigured");
  await settings({ enabled: false });
  expect(await ensureDownloadClient("sonarr", base, KEY)).toBe("unconfigured");
  expect(calls).toEqual([]);
});

it("does not transfer the owner's credentials without explicit sharing permission", async () => {
  await settings({ shareWithAddons: false }); const base = await addon();
  expect(await ensureDownloadClient("sonarr", base, KEY)).toBe("unconfigured");
  expect(calls).toEqual([]);
});

it("honors withdrawn sharing permission even though the transfer fingerprint remains unchanged", async () => {
  await settings(); const base = await addon("v3", async () => { await settings({ shareWithAddons: false }); });
  await expect(ensureDownloadClient("sonarr", base, KEY)).rejects.toThrow("changed while linking");
  expect(clients).toEqual([]); expect(calls.some(call => call.startsWith("POST"))).toBe(false);
});

it.each([{ active: false }, { role: "user" }])("does not transfer credentials when the owning administrator is no longer active: %j", async patch => {
  await settings(); await db.user.update({ where: { id: ownerId }, data: patch });
  const base = await addon();
  await expect(ensureDownloadClient("sonarr", base, KEY)).rejects.toThrow("Configure and enable");
  expect(calls).toEqual([]);
});

it("rechecks configuration before sending credentials after a slow schema response", async () => {
  await settings(); const base = await addon("v3", async () => { await settings({ username: "changed-owner" }); });
  await expect(ensureDownloadClient("sonarr", base, KEY)).rejects.toThrow("changed while linking");
  expect(clients).toEqual([]); expect(calls.some(call => call.startsWith("POST"))).toBe(false);
});

it("uses stable container DNS only after bundled access is approved and running", async () => {
  process.env.BUNDLED_QBIT_HOST = "streamrd-fixture";
  await settings({ baseUrl: "http://127.0.0.1:8082", allowBundledAccess: true }); const base = await addon();
  expect(await ensureDownloadClient("sonarr", base, KEY)).toBe("local-only");
  process.env.BUNDLED_QBIT_ACCESS_ACTIVE = "true";
  expect(await ensureDownloadClient("sonarr", base, KEY)).toBe("set");
  const fields = Object.fromEntries((clients[0].fields as { name: string; value: unknown }[]).map(field => [field.name, field.value]));
  expect(fields).toMatchObject({ host: "streamrd-fixture", port: 8082, useSsl: false, password: PASSWORD });
});
it("honors withdrawn bundled approval during a slow schema response", async () => {
  process.env.BUNDLED_QBIT_HOST = "streamrd-fixture"; process.env.BUNDLED_QBIT_ACCESS_ACTIVE = "true";
  await settings({ baseUrl: "http://127.0.0.1:8082", allowBundledAccess: true });
  const base = await addon("v3", async () => { await settings({ baseUrl: "http://127.0.0.1:8082", allowBundledAccess: false }); });
  await expect(ensureDownloadClient("sonarr", base, KEY)).rejects.toThrow("changed while linking");
  expect(clients).toEqual([]);
});
