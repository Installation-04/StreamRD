import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import { logEvent } from "./logger";
import { dockerControl } from "./maintenance";
import { manager } from "./media-servers";
import { getRequestSettings, qbitContext } from "./requests/config";
import { normalizeQbitUrl } from "./requests/clients";
import { bundledAccessActive, bundledPeerHost, isBundledQbitUrl } from "./bundled-qbit";

/**
 * Makes the add-ons that StreamRD started work together without anyone typing a key: each Sonarr, Radarr, Lidarr and Prowlarr is given a login
 * that StreamRD made up (kept encrypted, shown to administrators on the add-on's card), and Prowlarr is told about every Sonarr, Radarr and
 * Lidarr that runs, so the indexers kept in Prowlarr reach them. Everything is read from the add-on's own settings folder (its API key) and
 * done through the add-on's own API. It is safe to run again and again: what is already right is left alone.
 */
const SERVARR = {
  sonarr: { port: 8989, api: "v3", implementation: "Sonarr" },
  radarr: { port: 7878, api: "v3", implementation: "Radarr" },
  lidarr: { port: 8686, api: "v1", implementation: "Lidarr" },
  prowlarr: { port: 9696, api: "v1", implementation: "Prowlarr" },
} as const;
export type ServarrName = keyof typeof SERVARR;
export const SERVARR_NAMES = Object.keys(SERVARR) as ServarrName[];
const LOGINS = "addons.logins", USERNAME = "streamrd";

/** The add-on writes its API key to config.xml in its settings folder on first start; that folder is inside the one StreamRD keeps. */
export function servarrKey(name: ServarrName, root = process.env.CONFIG_DIR || process.env.DATA_DIR || "/data"): string {
  try { return /<ApiKey>([A-Za-z0-9]{16,64})<\/ApiKey>/.exec(fs.readFileSync(path.join(root, name, "config", "config.xml"), "utf8"))?.[1] ?? ""; } catch { return ""; }
}
type Stored = Partial<Record<ServarrName, { password: string }>>;
async function readLogins(): Promise<Stored> {
  const row = await db.setting.findUnique({ where: { key: LOGINS } });
  try { const value = JSON.parse(row?.value ?? "{}") as unknown; return value && typeof value === "object" ? value as Stored : {}; } catch { return {}; }
}
const writeLogins = (value: Stored) => db.setting.upsert({ where: { key: LOGINS }, create: { key: LOGINS, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
/** The login StreamRD made for an add-on, for the administrator to use; null until it has been set. */
export async function loginFor(name: ServarrName): Promise<{ username: string; password: string } | null> {
  const stored = (await readLogins())[name]; const password = stored ? decryptSecret(stored.password) : null;
  return password ? { username: USERNAME, password } : null;
}

const bases = (name: ServarrName, address?: string) => [process.env[`${name.toUpperCase()}_URL`], `http://streamrd-${name}:${SERVARR[name].port}`, address ? `http://${address.includes(":") ? `[${address}]` : address}:${SERVARR[name].port}` : undefined]
  .filter((value): value is string => Boolean(value)).map(value => value.replace(/\/+$/, ""));
async function ping(base: string): Promise<boolean> {
  try { const response = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(3000), redirect: "error" }); await response.body?.cancel(); return response.ok; } catch { return false; }
}
async function reach(name: ServarrName, address?: string): Promise<string | null> {
  for (const base of bases(name, address)) if (await ping(base)) return base;
  return null;
}
export async function call<T>(base: string, name: ServarrName, key: string, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/${SERVARR[name].api}${route}`, { method, headers: { "X-Api-Key": key, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${name} answered ${response.status} to ${method} ${route}`); }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

/** Gives the add-on a login (forms, required everywhere) that StreamRD made up, unless it already has the one StreamRD made. */
export async function ensureLogin(name: ServarrName, base: string, key: string): Promise<"set" | "kept"> {
  const logins = await readLogins(), kept = logins[name] ? decryptSecret(logins[name]!.password) : null;
  const host = await call<Record<string, unknown>>(base, name, key, "GET", "/config/host");
  if (kept && host.authenticationMethod === "forms" && host.username === USERNAME) return "kept";
  if (typeof host.username === "string" && host.username && (!kept || host.username !== USERNAME)) return "kept";   // someone chose a login of their own: it is theirs, and is not replaced
  const password = kept ?? randomBytes(18).toString("base64url");
  await call(base, name, key, "PUT", `/config/host/${String(host.id)}`, { ...host, authenticationMethod: "forms", authenticationRequired: "enabled", username: USERNAME, password, passwordConfirmation: password });
  logins[name] = { password: encryptSecret(password) }; await writeLogins(logins);
  void logEvent("info", "system", `${SERVARR[name].implementation} was given a login (shown to administrators on its card)`).catch(() => undefined);
  return "set";
}

interface Field { name: string; value?: unknown }
interface Schema { implementation: string; implementationName?: string; configContract: string; fields: Field[] }
type DownloadApp = "sonarr" | "radarr" | "lidarr";
/** Loopback and wildcard addresses identify the add-on itself, not StreamRD's bundled client. */
function localOnly(host: string): boolean {
  host = host.replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain" || /^127\./.test(host) || host === "0.0.0.0" || host === "[::]" || host === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i.test(host);
}
/** Adds the configured client only to a new add-on with no existing download-client choices. */
export async function ensureDownloadClient(name: DownloadApp, base: string, key: string): Promise<"set" | "kept" | "unconfigured" | "local-only"> {
  const { qbit } = await getRequestSettings();
  if (!qbit.enabled || !qbit.shareWithAddons) return "unconfigured";
  const context = await qbitContext(qbit.ownerId);
  const bundled = context.settings.allowBundledAccess && bundledAccessActive() && isBundledQbitUrl(context.settings.baseUrl);
  const url = new URL(bundled ? `http://${bundledPeerHost()}:8082` : normalizeQbitUrl(context.settings.baseUrl));
  if (localOnly(url.hostname)) return "local-only";
  const known = await call<unknown>(base, name, key, "GET", "/downloadclient");
  if (!Array.isArray(known)) throw new Error(`${SERVARR[name].implementation} returned an invalid download-client list`);
  if (known.length) return "kept"; // An owner's existing choices, including disabled clients, are preserved.
  const schemas = await call<Schema[]>(base, name, key, "GET", "/downloadclient/schema");
  const schema = schemas.find(entry => entry.implementation.toLowerCase() === "qbittorrent");
  if (!schema) throw new Error(`${SERVARR[name].implementation} has no qBittorrent client type`);
  const categoryField = { sonarr: "tvCategory", radarr: "movieCategory", lidarr: "musicCategory" }[name];
  const values: Record<string, unknown> = {
    host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), useSsl: url.protocol === "https:",
    urlBase: url.pathname.replace(/\/+$/, ""), username: context.settings.username, password: context.settings.password, [categoryField]: `streamrd-${name}`,
  };
  const names = new Set(schema.fields.map(field => field.name));
  if (["host", "port", "useSsl", "username", "password", categoryField, ...(values.urlBase ? ["urlBase"] : [])].some(field => !names.has(field))) throw new Error(`${SERVARR[name].implementation} returned an incomplete qBittorrent client type`);
  // Configuration may change while the add-on answers. Never send retired credentials.
  const fresh = await qbitContext(qbit.ownerId);
  if (!fresh.settings.shareWithAddons || (bundled && !fresh.settings.allowBundledAccess) || fresh.fingerprint !== context.fingerprint) throw new Error("The download-client connection changed while linking. Retry with its current settings.");
  await call(base, name, key, "POST", "/downloadclient", {
    name: "StreamRD qBittorrent", implementation: schema.implementation, configContract: schema.configContract,
    enable: true, protocol: "torrent", priority: 1, removeCompletedDownloads: false, removeFailedDownloads: false, tags: [],
    fields: schema.fields.map(field => field.name in values ? { ...field, value: values[field.name] } : field),
  });
  void logEvent("info", "system", `${SERVARR[name].implementation} was connected to the configured qBittorrent client`).catch(() => undefined);
  return "set";
}
/** Tells Prowlarr about an add-on, so what Prowlarr finds is sent to it. Returns false when Prowlarr already knows it. */
export async function linkToProwlarr(prowlarr: { base: string; key: string }, app: { name: ServarrName; base: string; key: string }, prowlarrUrl: string, appUrl: string): Promise<boolean> {
  const implementation = SERVARR[app.name].implementation;
  const known = await call<Array<{ implementation?: string; fields?: Field[] }>>(prowlarr.base, "prowlarr", prowlarr.key, "GET", "/applications");
  if (known.some(entry => entry.implementation === implementation && (entry.fields ?? []).some(field => field.name === "baseUrl" && String(field.value ?? "").replace(/\/+$/, "") === appUrl))) return false;
  const schemas = await call<Schema[]>(prowlarr.base, "prowlarr", prowlarr.key, "GET", "/applications/schema");
  const schema = schemas.find(entry => entry.implementation === implementation); if (!schema) throw new Error(`Prowlarr has no ${implementation} application type`);
  const values: Record<string, string> = { prowlarrUrl, baseUrl: appUrl, apiKey: app.key };
  await call(prowlarr.base, "prowlarr", prowlarr.key, "POST", "/applications", {
    name: implementation, implementation: schema.implementation, configContract: schema.configContract, syncLevel: "fullSync", tags: [],
    fields: schema.fields.map(field => field.name in values ? { ...field, value: values[field.name] } : field),
  });
  void logEvent("info", "system", `Prowlarr now sends its indexers to ${implementation}`).catch(() => undefined);
  return true;
}

/** Where a running add-on answers and its API key, or null when it is not running (or has not written its key yet). */
export async function connection(name: ServarrName): Promise<{ base: string; key: string } | null> {
  if (dockerControl().mode === "off") return null;
  let found: { state: string; address?: string } | undefined;
  try { found = (await manager<{ servers: Record<string, { state: string; address?: string }> }>("GET", "/status")).servers[name]; } catch { return null; }
  if (found?.state !== "running") return null;
  const key = servarrKey(name), base = key ? await reach(name, found.address) : null;
  return key && base ? { base, key } : null;
}

const MEDIA_FOLDERS = { sonarr: "tv", radarr: "movies", lidarr: "music" } as const;
/**
 * Gives Sonarr, Radarr and Lidarr a place to put what they import, under StreamRD's data folder (the one they share with the downloads), when
 * they have no root folder yet. A root folder someone added is left alone. The folder is made here first: the add-ons refuse one that is not there.
 */
export async function ensureRootFolder(name: keyof typeof MEDIA_FOLDERS, base: string, key: string, dataRoot = process.env.DATA_DIR || "/data"): Promise<boolean> {
  const existing = await call<unknown[]>(base, name, key, "GET", "/rootfolder");
  if (Array.isArray(existing) && existing.length) return false;
  const folder = path.join(dataRoot, "media", MEDIA_FOLDERS[name]); fs.mkdirSync(folder, { recursive: true });
  const body: Record<string, unknown> = { path: folder };
  if (name === "lidarr") {   // Lidarr's root folder carries the defaults for what is added under it
    const [quality, metadata] = await Promise.all([call<Array<{ id: number }>>(base, name, key, "GET", "/qualityprofile"), call<Array<{ id: number }>>(base, name, key, "GET", "/metadataprofile")]);
    if (!quality[0] || !metadata[0]) throw new Error("lidarr has no quality or metadata profile to give its root folder");
    Object.assign(body, { name: "Music", defaultQualityProfileId: quality[0].id, defaultMetadataProfileId: metadata[0].id, defaultMonitorOption: "all", defaultNewItemMonitorOption: "all", defaultTags: [] });
  }
  await call(base, name, key, "POST", "/rootfolder", body);
  void logEvent("info", "system", `${SERVARR[name].implementation} was given ${folder} to keep what it imports`).catch(() => undefined);
  return true;
}
/** Tells Prowlarr about FlareSolverr as a proxy, under a tag of the same name: an indexer behind a browser check is given that tag. */
export async function ensureFlareSolverr(prowlarr: { base: string; key: string }, host: string): Promise<boolean> {
  const proxies = await call<Array<{ implementation?: string }>>(prowlarr.base, "prowlarr", prowlarr.key, "GET", "/indexerProxy");
  if (proxies.some(entry => entry.implementation === "FlareSolverr")) return false;
  const schemas = await call<Schema[]>(prowlarr.base, "prowlarr", prowlarr.key, "GET", "/indexerProxy/schema");
  const schema = schemas.find(entry => entry.implementation === "FlareSolverr"); if (!schema) throw new Error("Prowlarr has no FlareSolverr proxy type");
  const tags = await call<Array<{ id: number; label: string }>>(prowlarr.base, "prowlarr", prowlarr.key, "GET", "/tag");
  const tag = tags.find(entry => entry.label === "flaresolverr") ?? await call<{ id: number }>(prowlarr.base, "prowlarr", prowlarr.key, "POST", "/tag", { label: "flaresolverr" });
  const values: Record<string, unknown> = { host, requestTimeout: 60 };
  await call(prowlarr.base, "prowlarr", prowlarr.key, "POST", "/indexerProxy", {
    name: "FlareSolverr", implementation: schema.implementation, configContract: schema.configContract, tags: [tag.id],
    fields: schema.fields.map(field => field.name in values ? { ...field, value: values[field.name] } : field),
  });
  void logEvent("info", "system", "Prowlarr can reach indexers behind a browser check through FlareSolverr (give such an indexer the flaresolverr tag)").catch(() => undefined);
  return true;
}

/** Bazarr keeps its API key in its settings folder (config/config/config.yaml, or config.ini on older versions). */
export function bazarrKey(root = process.env.CONFIG_DIR || process.env.DATA_DIR || "/data"): string {
  for (const folder of [["config", "config"], ["config"]]) for (const file of ["config.yaml", "config.ini"]) {   // Bazarr keeps them in <its folder>/config/config
    try { const found = /^\s*apikey\s*[:=]\s*['"]?([A-Za-z0-9]{16,64})['"]?\s*$/m.exec(fs.readFileSync(path.join(root, "bazarr", ...folder, file), "utf8")); if (found) return found[1]; } catch { /* try the next */ }
  }
  return "";
}
/** Where Bazarr answers: the address from the probe order used for the others. */
async function reachBazarr(address?: string): Promise<string | null> {
  const list = [process.env.BAZARR_URL, "http://streamrd-bazarr:6767", address ? `http://${address.includes(":") ? `[${address}]` : address}:6767` : undefined]
    .filter((value): value is string => Boolean(value)).map(value => value.replace(/\/+$/, ""));
  for (const base of list) {
    try { const response = await fetch(`${base}/api/system/ping`, { signal: AbortSignal.timeout(3000), redirect: "manual" }); await response.body?.cancel(); if (response.status < 500) return base; /* any answer means it is up */ } catch { /* next */ }
  }
  return null;
}
/**
 * Tells Bazarr where Sonarr and Radarr are (address, port, API key) when it has none yet, and turns them on. A source someone already
 * filled in is left alone. Done through Bazarr's own settings API, with the addresses that passed the probe.
 */
export async function ensureBazarrSources(bazarr: { base: string; key: string }, sources: Partial<Record<"sonarr" | "radarr", { base: string; key: string }>>): Promise<string[]> {
  const headers = { "X-API-KEY": bazarr.key, Accept: "application/json" };
  const current = await fetch(`${bazarr.base}/api/system/settings`, { headers, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!current.ok) { await current.body?.cancel(); throw new Error(`bazarr answered ${current.status} to GET /api/system/settings`); }
  const settings = await current.json() as Record<string, Record<string, unknown> | undefined>;
  const form = new URLSearchParams(), done: string[] = [];
  for (const name of ["sonarr", "radarr"] as const) {
    const source = sources[name]; if (!source) continue;
    const have = settings[name]; if (have && typeof have.apikey === "string" && have.apikey) continue;
    const url = new URL(source.base);
    form.set(`settings-${name}-ip`, url.hostname.replace(/^\[|\]$/g, "")); form.set(`settings-${name}-port`, url.port || (url.protocol === "https:" ? "443" : "80"));
    form.set(`settings-${name}-apikey`, source.key); form.set(`settings-${name}-ssl`, url.protocol === "https:" ? "true" : "false"); form.set(`settings-${name}-base_url`, "/");
    form.set(`settings-general-use_${name}`, "true"); done.push(name);
  }
  if (!done.length) return done;
  const saved = await fetch(`${bazarr.base}/api/system/settings`, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(15_000), redirect: "error" });
  await saved.body?.cancel();
  if (!saved.ok) throw new Error(`bazarr answered ${saved.status} to POST /api/system/settings`);
  void logEvent("info", "system", `Bazarr now looks at ${done.join(" and ")} for what to find subtitles for`).catch(() => undefined);
  return done;
}

export interface LinkReport { logins: ServarrName[]; linked: ServarrName[]; waiting: ServarrName[]; downloadClients: DownloadApp[]; downloadClientWaiting: DownloadApp[]; rootFolders: string[]; flaresolverr: boolean; bazarr: string[]; errors: string[] }
let linking: Promise<LinkReport> | undefined;
/** Manual requests and the background timer share one pass so credentials and links cannot race. */
export function linkAddons(): Promise<LinkReport> {
  if (!linking) linking = linkAddonsPass().finally(() => { linking = undefined; });
  return linking;
}
/** One pass over every Servarr add-on that is running: a login for each, and Prowlarr told about the others. */
async function linkAddonsPass(): Promise<LinkReport> {
  const report: LinkReport = { logins: [], linked: [], waiting: [], downloadClients: [], downloadClientWaiting: [], rootFolders: [], flaresolverr: false, bazarr: [], errors: [] };
  if (dockerControl().mode === "off") return report;
  let status: Record<string, { state: string; address?: string }> = {};
  try { status = (await manager<{ servers: typeof status }>("GET", "/status")).servers; } catch { return report; }
  const up: Partial<Record<ServarrName, { base: string; key: string }>> = {};
  for (const name of SERVARR_NAMES) {
    if (status[name]?.state !== "running") continue;
    const key = servarrKey(name), base = key ? await reach(name, status[name].address) : null;
    if (!key || !base) { report.waiting.push(name); continue; }
    up[name] = { base, key };
  }
  for (const name of SERVARR_NAMES) {
    const one = up[name]; if (!one) continue;
    try { if (await ensureLogin(name, one.base, one.key) === "set") report.logins.push(name); } catch (error) { report.errors.push(`${name}: ${error instanceof Error ? error.message : "failed"}`.slice(0, 200)); }
  }
  const prowlarr = up.prowlarr;
  if (prowlarr) for (const name of ["sonarr", "radarr", "lidarr"] as const) {
    const one = up[name]; if (!one) continue;
    // Reuse the addresses that passed the probe. Container aliases only resolve
    // on a user-defined Docker network, not on the default bridge.
    try { if (await linkToProwlarr(prowlarr, { name, ...one }, prowlarr.base, one.base)) report.linked.push(name); }
    catch (error) { report.errors.push(`${name}: ${error instanceof Error ? error.message : "failed"}`.slice(0, 200)); }
  }
  for (const name of ["sonarr", "radarr", "lidarr"] as const) {
    const one = up[name]; if (!one) continue;
    try {
      const result = await ensureDownloadClient(name, one.base, one.key);
      if (result === "set") report.downloadClients.push(name);
      if (result === "local-only") report.downloadClientWaiting.push(name);
    } catch (error) { report.errors.push(`${name}: ${error instanceof Error ? error.message : "failed"}`.slice(0, 200)); }
  }
  for (const name of ["sonarr", "radarr", "lidarr"] as const) {
    const one = up[name]; if (!one) continue;
    try { if (await ensureRootFolder(name, one.base, one.key)) report.rootFolders.push(name); } catch (error) { report.errors.push(`${name}: ${error instanceof Error ? error.message : "failed"}`.slice(0, 200)); }
  }
  if (prowlarr && status.flaresolverr?.state === "running") {
    try { report.flaresolverr = await ensureFlareSolverr(prowlarr, `http://${status.flaresolverr.address ?? "streamrd-flaresolverr"}:8191`); }
    catch (error) { report.errors.push(`flaresolverr: ${error instanceof Error ? error.message : "failed"}`.slice(0, 200)); }
  }
  if (status.bazarr?.state === "running" && (up.sonarr || up.radarr)) {
    const key = bazarrKey(), base = key ? await reachBazarr(status.bazarr.address) : null;
    if (!key || !base) report.waiting.push("bazarr" as ServarrName);
    else try { report.bazarr = await ensureBazarrSources({ base, key }, { sonarr: up.sonarr, radarr: up.radarr }); }
    catch (error) { report.errors.push(`bazarr: ${error instanceof Error ? error.message : "failed"}`.slice(0, 200)); }
  }
  return report;
}
let timer: ReturnType<typeof setInterval> | undefined;
/** Every few minutes, so an add-on started from the page is signed in and linked without anyone pressing anything. */
export function startAddonLinks(firstAfterMs = 60_000, everyMs = 3 * 60_000): void {
  if (timer) return;
  const tick = () => { void linkAddons().catch(() => undefined); };
  setTimeout(tick, firstAfterMs).unref(); timer = setInterval(tick, everyMs); timer.unref();
}
