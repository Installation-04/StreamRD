import { Router } from "express";
import { z } from "zod";
import { db } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import { requireAuth, requireAdmin } from "./auth/middleware";
import { asyncHandler } from "./http";
import { logEvent } from "./logger";
import { parseBody } from "./routes/helpers";
import { rateLimit } from "./util/rateLimit";

/**
 * Plex and Jellyfin next to StreamRD. The administrator saves a port and, optionally, the server's own token (a Plex token or a Jellyfin
 * API key, stored encrypted) so StreamRD can ask it to rescan the exported libraries. A server can be started from here when the
 * optional media manager is installed (install.sh --media-manager): StreamRD only asks the manager, and the manager alone holds the
 * Docker socket. The Plex claim token is passed to the launch once and is never stored.
 */
const KEY = "media.servers", NAMES = ["jellyfin", "plex"] as const;
type Name = (typeof NAMES)[number];
const DEFAULT_PORT: Record<Name, number> = { jellyfin: 8096, plex: 32400 };
const port = z.number().int().min(1024).max(65535);
interface Stored { jellyfin: { port: number; secret: string }; plex: { port: number; secret: string } }
const empty = (): Stored => ({ jellyfin: { port: DEFAULT_PORT.jellyfin, secret: "" }, plex: { port: DEFAULT_PORT.plex, secret: "" } });
const storedSchema = z.object({ jellyfin: z.object({ port, secret: z.string().max(1500) }), plex: z.object({ port, secret: z.string().max(1500) }) });

async function readStored(): Promise<Stored> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  try { return storedSchema.parse(JSON.parse(row?.value ?? "null")); } catch { return empty(); }
}
const writeStored = (value: Stored) => db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
/** True once a Plex token or Jellyfin API key has been saved: the setup checklist counts that as a media server being set up. */
export async function mediaServerTokenSaved(): Promise<boolean> { const stored = await readStored(); return Boolean(stored.jellyfin.secret || stored.plex.secret); }
const secretOf = (stored: Stored, name: Name) => decryptSecret(stored[name].secret) ?? "";
const hint = (value: string) => value ? (value.length <= 4 ? "****" : `****${value.slice(-4)}`) : null;

/* ------------------------------ the media manager ------------------------------ */
const managerConfig = () => ({ url: (process.env.MEDIA_MANAGER_URL ?? "").replace(/\/+$/, ""), token: process.env.MEDIA_MANAGER_TOKEN ?? "" });
class ManagerError extends Error { constructor(message: string, public status = 502) { super(message); } }
async function manager<T>(method: string, route: string, body?: unknown): Promise<T> {
  const { url, token } = managerConfig();
  if (!url || !token) throw new ManagerError("Launching from here needs the media manager. Run the installer again with --media-manager (see the Plex and Jellyfin guide).", 409);
  let response: Response;
  try { response = await fetch(url + route, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000), redirect: "error" }); }
  catch { throw new ManagerError("The media manager did not answer. Check that its container is running."); }
  const json = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new ManagerError(typeof json.error === "string" ? json.error : "The media manager refused the request.", response.status >= 400 && response.status < 500 ? 400 : 502);
  return json as T;
}
type ServerState = { state: "absent" | "stopped" | "running" | "pulling" | "starting" | "failed"; port?: number; error?: string };
async function managerStatus(): Promise<{ available: boolean; servers: Partial<Record<Name, ServerState>> }> {
  const { url, token } = managerConfig();
  if (!url || !token) return { available: false, servers: {} };
  try { return { available: true, servers: (await manager<{ servers: Record<Name, ServerState> }>("GET", "/status")).servers }; } catch { return { available: false, servers: {} }; }
}

/* --------------------------- talking to the media servers --------------------------- */
// Where StreamRD can reach each server: the address the manager gives it, or the Compose service from install.sh --media-server.
const bases = (name: Name) => [process.env[`${name.toUpperCase()}_URL`], `http://streamrd-${name}:${DEFAULT_PORT[name]}`, `http://${name}:${DEFAULT_PORT[name]}`].filter((value): value is string => Boolean(value)).map(value => value.replace(/\/+$/, ""));
async function reach<T>(name: Name, route: string, init: RequestInit): Promise<{ status: number; json: T | null } | null> {
  for (const base of bases(name)) {
    try {
      const response = await fetch(base + route, { ...init, signal: AbortSignal.timeout(8_000), redirect: "error" });
      return { status: response.status, json: await response.json().catch(() => null) as T | null };
    } catch { /* try the next address */ }
  }
  return null;
}
const plexHeaders = (token: string) => ({ Accept: "application/json", ...(token ? { "X-Plex-Token": token } : {}) });
const jellyfinHeaders = (token: string) => ({ Accept: "application/json", ...(token ? { "X-Emby-Token": token } : {}) });

/** Asks the server to rescan the libraries StreamRD exports (those under /library). Returns how many were asked. */
export async function refreshLibraries(name: Name): Promise<{ refreshed: number }> {
  const stored = await readStored(), token = secretOf(stored, name);
  if (!token) throw new ManagerError(name === "plex" ? "Save your Plex token first." : "Save a Jellyfin API key first.", 409);
  if (name === "jellyfin") {
    const answer = await reach<unknown>("jellyfin", "/Library/Refresh", { method: "POST", headers: jellyfinHeaders(token) });
    if (!answer) throw new ManagerError("Jellyfin could not be reached. Is it running?");
    if (answer.status === 401 || answer.status === 403) throw new ManagerError("Jellyfin did not accept that API key.", 400);
    if (answer.status >= 400) throw new ManagerError("Jellyfin could not start the refresh.");
    return { refreshed: 1 };
  }
  const sections = await reach<{ MediaContainer?: { Directory?: Array<{ key?: string; Location?: Array<{ path?: string }> }> } }>("plex", "/library/sections", { headers: plexHeaders(token) });
  if (!sections) throw new ManagerError("Plex could not be reached. Is it running?");
  if (sections.status === 401) throw new ManagerError("Plex did not accept that token.", 400);
  if (sections.status >= 400) throw new ManagerError("Plex could not list its libraries.");
  const ours = (sections.json?.MediaContainer?.Directory ?? []).filter(section => /^\d{1,9}$/.test(String(section.key)) && (section.Location ?? []).some(location => typeof location.path === "string" && location.path.startsWith("/library/")));
  for (const section of ours) await reach("plex", `/library/sections/${section.key}/refresh`, { headers: plexHeaders(token) });
  return { refreshed: ours.length };
}

async function testConnection(name: Name): Promise<{ reachable: boolean; accepted: boolean | null }> {
  const token = secretOf(await readStored(), name);
  const answer = name === "plex" ? await reach("plex", "/library/sections", { headers: plexHeaders(token) }) : await reach("jellyfin", token ? "/System/Info" : "/System/Info/Public", { headers: jellyfinHeaders(token) });
  if (!answer) return { reachable: false, accepted: null };
  return { reachable: true, accepted: token ? answer.status < 400 : null };
}

/* --------------------------------- the routes --------------------------------- */
const name = z.enum(NAMES);
export const mediaServersRouter = Router();
mediaServersRouter.use(requireAuth, requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
mediaServersRouter.param("server", (_req, res, next, value: string) => { if ((NAMES as readonly string[]).includes(value)) next(); else res.status(404).json({ error: "Unknown media server." }); });
async function view() {
  const [stored, status] = await Promise.all([readStored(), managerStatus()]);
  const one = (key: Name) => ({ port: stored[key].port, state: (status.servers[key]?.state ?? (status.available ? "absent" : "unknown")) as ServerState["state"] | "unknown", ...(status.servers[key]?.error ? { error: status.servers[key]!.error } : {}), secretHint: hint(secretOf(stored, key)) });
  return { manager: { available: status.available }, servers: { jellyfin: one("jellyfin"), plex: one("plex") } };
}
mediaServersRouter.get("/", asyncHandler(async (_req, res) => { res.json(await view()); }));
mediaServersRouter.put("/", rateLimit({ windowMs: 60_000, max: 30 }), asyncHandler(async (req, res) => {
  const body = parseBody(z.object({ jellyfin: z.object({ port: port.optional(), secret: z.string().trim().min(1).max(500).nullable().optional() }).strict().optional(), plex: z.object({ port: port.optional(), secret: z.string().trim().min(1).max(500).nullable().optional() }).strict().optional() }).strict(), req.body, res);
  if (!body) return;
  const stored = await readStored();
  for (const key of NAMES) {
    const change = body[key]; if (!change) continue;
    if (change.port !== undefined) stored[key].port = change.port;
    if (change.secret !== undefined) stored[key].secret = change.secret === null ? "" : encryptSecret(change.secret);
  }
  await writeStored(stored);
  void logEvent("info", "admin_action", "Updated media server settings", { userId: req.session!.sub });
  res.json(await view());
}));
mediaServersRouter.post("/:server/launch", rateLimit({ windowMs: 60_000, max: 12 }), asyncHandler(async (req, res) => {
  const key = name.parse(req.params.server);
  const body = parseBody(z.object({ port: port.optional(), claim: z.string().trim().max(120).optional() }).strict(), req.body ?? {}, res);
  if (!body) return;
  const stored = await readStored(); if (body.port !== undefined) { stored[key].port = body.port; await writeStored(stored); }
  try {
    // The claim token goes to the launch and nowhere else: it is not saved, logged or returned.
    const job = await manager<{ state: string }>("POST", `/servers/${key}/launch`, { port: stored[key].port, ...(key === "plex" && body.claim ? { claim: body.claim } : {}) });
    void logEvent("info", "admin_action", `Started ${key}`, { userId: req.session!.sub, meta: { port: stored[key].port } });
    res.status(202).json({ state: job.state });
  } catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}));
for (const [method, suffix, route] of [["post", "/:server/stop", "stop"], ["delete", "/:server", ""]] as const) {
  mediaServersRouter[method](suffix, rateLimit({ windowMs: 60_000, max: 30 }), asyncHandler(async (req, res) => {
    const key = name.parse(req.params.server);
    try { await manager("POST" === method.toUpperCase() ? "POST" : "DELETE", `/servers/${key}${route ? `/${route}` : ""}`); void logEvent("info", "admin_action", route ? `Stopped ${key}` : `Removed ${key}`, { userId: req.session!.sub }); res.json({ ok: true }); }
    catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
  }));
}
mediaServersRouter.get("/:server/logs", rateLimit({ windowMs: 60_000, max: 120 }), asyncHandler(async (req, res) => {
  const { tail } = parseBody(z.object({ tail: z.coerce.number().int().min(1).max(200).default(100) }).strict(), req.query, res) ?? {};
  if (tail === undefined) return;
  try { res.json(await manager<{ deploy: unknown[]; container: string[] }>("GET", `/servers/${req.params.server}/logs?tail=${tail}`)); }
  catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}));
mediaServersRouter.post("/:server/test", rateLimit({ windowMs: 60_000, max: 30 }), asyncHandler(async (req, res) => { res.json(await testConnection(name.parse(req.params.server))); }));
mediaServersRouter.post("/:server/refresh", rateLimit({ windowMs: 60_000, max: 12 }), asyncHandler(async (req, res) => {
  try { res.json(await refreshLibraries(name.parse(req.params.server))); }
  catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}));
