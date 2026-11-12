import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { db } from "./db";
import { logEvent } from "./logger";
import { asyncHandler } from "./http";
import { requireAdmin, requireAuth } from "./auth/middleware";
import { dockerControl } from "./maintenance";
import { manager, ManagerError } from "./media-servers";
import { rateLimit } from "./util/rateLimit";

/**
 * Prowlarr keeps the list of indexers that requests search. It runs next to StreamRD, in a container of its own that the Docker helper
 * starts (Docker control on, the installer's default), and is the one place indexers are added: StreamRD reads its API key from the settings
 * folder it shares, and every enabled torrent indexer in Prowlarr becomes a source for the release search, found automatically.
 *
 * It is on by default and can be removed from the page; a removal is remembered, so it is not started again until someone asks.
 */
const KEY = "prowlarr.state", INDEXERS = "prowlarr.indexers", PORT = 9696;
interface Stored { declined: boolean; port: number }
const read = async (): Promise<Stored> => {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  try { const value = JSON.parse(row?.value ?? "{}") as Partial<Stored>; return { declined: value.declined === true, port: Number.isInteger(value.port) && value.port! >= 1024 && value.port! <= 65535 ? value.port! : PORT }; } catch { return { declined: false, port: PORT }; }
};
const write = (value: Stored) => db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });

/** Prowlarr writes its API key to config.xml in its settings folder on first start; that folder is inside the one StreamRD already keeps. */
export function prowlarrApiKey(root = process.env.CONFIG_DIR || process.env.DATA_DIR || "/data"): string {
  try { return /<ApiKey>([A-Za-z0-9]{16,64})<\/ApiKey>/.exec(fs.readFileSync(path.join(root, "prowlarr", "config", "config.xml"), "utf8"))?.[1] ?? ""; } catch { return ""; }
}
type HelperServer = { state: string; port?: number; error?: string; autostart?: boolean; address?: string };
async function helperState(): Promise<HelperServer | null> {
  if (dockerControl().mode === "off") return null;
  try { return (await manager<{ servers: Record<string, HelperServer> }>("GET", "/status")).servers.prowlarr ?? null; } catch { return null; }
}

// Where Prowlarr can be reached from here: its name on a network shared with StreamRD, else the address Docker gave it.
let reached: { base: string; at: number } | null = null;
async function ping(base: string): Promise<boolean> {
  try { const response = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(3000), redirect: "error" }); await response.body?.cancel(); return response.ok; } catch { return false; }
}
export async function prowlarrBase(): Promise<string | null> {
  if (reached && Date.now() - reached.at < 60_000) return reached.base;
  const state = await helperState();
  const candidates = [process.env.PROWLARR_URL, `http://streamrd-prowlarr:${PORT}`, state?.address ? `http://${state.address.includes(":") ? `[${state.address}]` : state.address}:${PORT}` : undefined]
    .filter((value): value is string => Boolean(value)).map(value => value.replace(/\/+$/, ""));
  for (const base of candidates) if (await ping(base)) { reached = { base, at: Date.now() }; return base; }
  reached = null; return null;
}

export interface SyncedIndexer { id: number; name: string }
/** The enabled torrent indexers Prowlarr has, as of the last sync. */
export async function syncedIndexers(): Promise<SyncedIndexer[]> {
  const row = await db.setting.findUnique({ where: { key: INDEXERS } });
  try { const list = JSON.parse(row?.value ?? "[]") as unknown; return Array.isArray(list) ? list.filter((entry): entry is SyncedIndexer => !!entry && typeof entry.id === "number" && typeof entry.name === "string").slice(0, 100) : []; } catch { return []; }
}
/** Torznab sources for the release search: one per indexer in Prowlarr, addressed where Prowlarr is right now. Empty until Prowlarr is up and has an indexer. */
export async function prowlarrSources(): Promise<Array<{ id: string; name: string; baseUrl: string; apiKey: string; builtin: true }>> {
  const key = prowlarrApiKey(); if (!key) return [];
  const list = await syncedIndexers(); if (!list.length) return [];
  const base = await prowlarrBase(); if (!base) return [];
  return list.map(entry => ({ id: `prowlarr-${entry.id}`, name: `Prowlarr · ${entry.name}`.slice(0, 80), baseUrl: `${base}/${entry.id}/api`, apiKey: key, builtin: true as const }));
}
/** Reads Prowlarr's indexer list and keeps the enabled torrent ones. Returns how many, or null when Prowlarr cannot be asked yet. */
export async function syncIndexers(): Promise<number | null> {
  const key = prowlarrApiKey(), base = key ? await prowlarrBase() : null;
  if (!key || !base) return null;
  let body: unknown;
  try {
    const response = await fetch(`${base}/api/v1/indexer`, { headers: { "X-Api-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) return null; body = await response.json();
  } catch { return null; }
  if (!Array.isArray(body)) return null;
  const found: SyncedIndexer[] = body.filter((entry): entry is { id: number; name: string; enable?: boolean; protocol?: string } => !!entry && typeof entry.id === "number" && typeof entry.name === "string")
    .filter(entry => entry.enable !== false && (entry.protocol ?? "torrent") === "torrent").map(entry => ({ id: entry.id, name: entry.name.slice(0, 60) })).slice(0, 100);
  const value = JSON.stringify(found);
  const before = (await db.setting.findUnique({ where: { key: INDEXERS } }))?.value;
  if (before !== value) { await db.setting.upsert({ where: { key: INDEXERS }, create: { key: INDEXERS, value }, update: { value } }); void logEvent("info", "system", `Prowlarr has ${found.length} indexer${found.length === 1 ? "" : "s"} for release search`).catch(() => undefined); }
  return found.length;
}

export interface ProwlarrView { available: boolean; state: string; port: number; error: string | null; declined: boolean; keyFound: boolean; indexers: number; reachable: boolean }
export async function prowlarrView(): Promise<ProwlarrView> {
  const [stored, state, indexers] = await Promise.all([read(), helperState(), syncedIndexers()]);
  return { available: dockerControl().mode !== "off", state: state?.state ?? (dockerControl().mode === "off" ? "unknown" : "absent"), port: state?.port ?? stored.port, error: state?.error ?? null, declined: stored.declined,
    keyFound: Boolean(prowlarrApiKey()), indexers: indexers.length, reachable: state?.state === "running" && Boolean(await prowlarrBase()) };
}
/** Starts Prowlarr if it is wanted and not there; keeps its indexers in step. Safe to call often. */
export async function ensureProwlarr(): Promise<"started" | "running" | "declined" | "unavailable" | "starting"> {
  const stored = await read();
  if (stored.declined) return "declined";
  if (dockerControl().mode === "off") return "unavailable";
  const state = await helperState();
  if (!state) return "unavailable";
  if (state.state === "absent" || state.state === "failed") {
    await manager("POST", "/servers/prowlarr/launch", { port: stored.port, autostart: true });
    void logEvent("info", "system", "Starting Prowlarr, which finds releases for requests").catch(() => undefined);
    return "started";
  }
  if (state.state === "running") { await syncIndexers(); return "running"; }
  return "starting";
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startProwlarr(firstAfterMs = 20_000, everyMs = 10 * 60_000): void {
  if (timer) return;
  const tick = () => { void ensureProwlarr().catch(() => undefined); };
  setTimeout(tick, firstAfterMs).unref(); timer = setInterval(tick, everyMs); timer.unref();
}

export const prowlarrRouter = Router();
prowlarrRouter.use(requireAuth, requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
const limit = rateLimit({ windowMs: 60_000, max: 20 });
const guard = (run: Parameters<typeof asyncHandler>[0]) => asyncHandler(async (req, res, next) => {
  try { await run(req, res, next); } catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
});
prowlarrRouter.get("/", guard(async (_req, res) => { res.json({ prowlarr: await prowlarrView() }); }));
/** Start it (again): clears a removal and launches. */
prowlarrRouter.post("/start", limit, guard(async (req, res) => {
  const stored = await read(); await write({ ...stored, declined: false });
  const outcome = await ensureProwlarr();
  if (outcome === "unavailable") { res.status(409).json({ error: "Starting Prowlarr from here needs Docker control, which is off on this server (see Admin → System)." }); return; }
  void logEvent("info", "admin_action", "Started Prowlarr", { userId: req.session!.sub }).catch(() => undefined);
  res.status(202).json({ prowlarr: await prowlarrView() });
}));
prowlarrRouter.post("/sync", limit, guard(async (_req, res) => {
  const count = await syncIndexers();
  res.json({ indexers: count, prowlarr: await prowlarrView() });
}));
/** Remove it, and keep it off: its settings stay in the settings folder. */
prowlarrRouter.delete("/", limit, guard(async (req, res) => {
  const stored = await read(); await write({ ...stored, declined: true });
  if (dockerControl().mode !== "off") await manager("DELETE", "/servers/prowlarr");
  await db.setting.deleteMany({ where: { key: INDEXERS } }); reached = null;
  void logEvent("info", "admin_action", "Removed Prowlarr", { userId: req.session!.sub }).catch(() => undefined);
  res.json({ prowlarr: await prowlarrView() });
}));
