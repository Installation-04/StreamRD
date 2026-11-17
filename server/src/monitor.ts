import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "./auth/middleware";
import { db } from "./db";
import { asyncHandler } from "./http";
import { dockerControl } from "./maintenance";
import { manager, ManagerError } from "./media-servers";
import { rateLimit } from "./util/rateLimit";
import { parseBody } from "./routes/helpers";
import { CATALOG } from "./addons";

/**
 * Admin → Monitor: what every program StreamRD runs has written lately, in one place. The sources are StreamRD's own event log, the processes inside
 * its container, the add-ons and media servers it started, and the optional services (Zilean, Zurg) the installer puts beside it. The reading is done
 * by the Docker helper, which only reads containers StreamRD runs; this file labels what it finds and adds the event log.
 */
export const monitorRouter = Router();
monitorRouter.use(requireAuth, requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
const limit = rateLimit({ windowMs: 60_000, max: 180 });

const CORE: Record<string, string> = { "core:streamrd-api": "StreamRD server", "core:streamrd-web": "StreamRD web", "core:qbittorrent": "qBittorrent", "core:gateway": "Gateway", "core:container": "Container",
  "core:phosphor-api": "Phosphor server", "core:phosphor-web": "Phosphor web" };
const SERVICE: Record<string, string> = { zilean: "Zilean", "zilean-db": "Zilean database", zurg: "Zurg", "zurg-rclone": "Zurg mount (rclone)" };
const MEDIA: Record<string, string> = { jellyfin: "Jellyfin", plex: "Plex" };
interface Found { id: string; state: string; lines?: number; label?: string }
export interface Source { id: string; label: string; group: "StreamRD" | "Add-ons" | "Media servers" | "Services"; state: string; lines?: number }
function describe(found: Found): Source | null {
  const [kind, name] = found.id.split(":");
  if (kind === "core") return { id: found.id, label: CORE[found.id] ?? name, group: "StreamRD", state: found.state, lines: found.lines };
  if (kind === "app") { const label = MEDIA[name] ?? CATALOG[name]?.label; return label ? { id: found.id, label, group: MEDIA[name] ? "Media servers" : "Add-ons", state: found.state } : null; }
  if (kind === "sup" && found.label) return { id: found.id, label: found.label.slice(0, 60), group: "Services", state: found.state };
  if (kind === "svc" && SERVICE[name]) return { id: found.id, label: SERVICE[name], group: "Services", state: found.state };
  return null;
}
const EVENTS: Source = { id: "events", label: "StreamRD events", group: "StreamRD", state: "running" };

monitorRouter.get("/sources", limit, asyncHandler(async (_req, res) => {
  const control = dockerControl();
  let found: Source[] = [], note: string | null = null;
  if (control.mode === "off") note = "The logs of the other programs need Docker control, which is off on this server (the installer turns it on).";
  else {
    try { found = (await manager<{ sources: Found[] }>("GET", "/logs/sources")).sources.map(describe).filter((entry): entry is Source => entry !== null && entry.state !== "absent"); }
    catch (error) { note = error instanceof ManagerError ? error.message : "The helper that talks to Docker did not answer."; }
  }
  res.json({ control: control.mode, note, sources: [EVENTS, ...found] });
}));

const query = z.object({ source: z.string().regex(/^(all|events|(core|app|svc|sup):[a-z0-9-]{1,30})$/).default("all"), tail: z.coerce.number().int().min(1).max(1000).default(200), q: z.string().trim().max(200).optional() }).strict();
monitorRouter.get("/logs", limit, asyncHandler(async (req, res) => {
  const parsed = parseBody(query, req.query, res); if (!parsed) return;
  const needle = parsed.q?.toLowerCase();
  const events = async (tail: number) => (await db.logEvent.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: tail, ...(parsed.q ? { where: { OR: [{ message: { contains: parsed.q } }, { type: { contains: parsed.q } }] } } : {}) }))
    .reverse().map(row => ({ time: row.createdAt.toISOString(), source: "events", level: row.level, text: `[${row.type}] ${row.message}`.slice(0, 600) }));
  let lines: Array<{ time: string; source: string; level?: string; text: string }> = [];
  if (parsed.source === "events") lines = await events(parsed.tail);
  else {
    if (dockerControl().mode === "off") { res.status(409).json({ error: "The logs of the other programs need Docker control, which is off on this server." }); return; }
    try { lines = (await manager<{ lines: typeof lines }>("GET", `/logs/read?source=${encodeURIComponent(parsed.source)}&tail=${parsed.tail}`)).lines; }
    catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
    if (parsed.source === "all") lines = [...await events(parsed.tail), ...lines].sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0).slice(-parsed.tail);
  }
  if (needle) lines = lines.filter(line => line.text.toLowerCase().includes(needle));
  res.json({ source: parsed.source, lines });
}));
