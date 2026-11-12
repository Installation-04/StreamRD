import { Router } from "express";
import { z } from "zod";
import { db } from "./db";
import { logEvent } from "./logger";
import { asyncHandler } from "./http";
import { requireAdmin, requireAuth } from "./auth/middleware";
import { parseBody } from "./routes/helpers";
import { dockerControl } from "./maintenance";
import { manager, ManagerError } from "./media-servers";
import { removeProwlarr, requestProwlarr } from "./prowlarr";
import { rateLimit } from "./util/rateLimit";

/**
 * The add-on marketplace: programs people usually run next to a media server, each started from a fixed specification by the Docker
 * helper (Docker control on, the installer's default) the way Prowlarr, Jellyfin and Plex are. This file is the list people see and the
 * routes behind its buttons; what a container is made of (image, folders, user) is decided in the helper, never here and never by the caller.
 *
 * They are separate programs with their own licences and releases. None of their code is part of StreamRD: the image of each is downloaded
 * from its maker when an administrator asks for it.
 */
export const GROUPS = ["Organise", "Subtitles", "Requests and stats", "Indexers", "Clean up"] as const;
interface Entry { label: string; group: (typeof GROUPS)[number]; blurb: string; port: number; ui: boolean; home: string; licence: string; needs?: string }
export const CATALOG: Record<string, Entry> = {
  sonarr: { label: "Sonarr", group: "Organise", blurb: "Keeps your TV shows in order and fetches new episodes as they air.", port: 8989, ui: true, home: "https://sonarr.tv", licence: "GPL-3.0", needs: "Prowlarr for indexers, a download client" },
  radarr: { label: "Radarr", group: "Organise", blurb: "Keeps your movies in order and fetches the ones you ask for.", port: 7878, ui: true, home: "https://radarr.video", licence: "GPL-3.0", needs: "Prowlarr for indexers, a download client" },
  lidarr: { label: "Lidarr", group: "Organise", blurb: "Keeps your music in order and fetches new albums by the artists you follow.", port: 8686, ui: true, home: "https://lidarr.audio", licence: "GPL-3.0", needs: "Prowlarr for indexers, a download client" },
  bazarr: { label: "Bazarr", group: "Subtitles", blurb: "Finds and downloads subtitles for the shows and movies Sonarr and Radarr manage.", port: 6767, ui: true, home: "https://www.bazarr.media", licence: "GPL-3.0", needs: "Sonarr and/or Radarr" },
  seerr: { label: "Seerr", group: "Requests and stats", blurb: "People search for a movie or show and request it with one click; it hands the request to Sonarr or Radarr.", port: 5055, ui: true, home: "https://github.com/seerr-team/seerr", licence: "MIT", needs: "Plex or Jellyfin, and Sonarr and/or Radarr" },
  tautulli: { label: "Tautulli", group: "Requests and stats", blurb: "Shows who watched what on Plex, when, and from where.", port: 8181, ui: true, home: "https://tautulli.com", licence: "GPL-3.0", needs: "Plex" },
  prowlarr: { label: "Prowlarr", group: "Indexers", blurb: "Keeps the list of indexers once, and shares it with StreamRD, Sonarr, Radarr and Lidarr.", port: 9696, ui: true, home: "https://prowlarr.com", licence: "GPL-3.0" },
  flaresolverr: { label: "FlareSolverr", group: "Indexers", blurb: "Lets Prowlarr reach indexers that sit behind a browser check. Nothing to open; Prowlarr talks to it.", port: 8191, ui: false, home: "https://github.com/FlareSolverr/FlareSolverr", licence: "MIT", needs: "Prowlarr" },
  maintainerr: { label: "Maintainerr", group: "Clean up", blurb: "Rules that tidy the library, such as removing what nobody has watched in months.", port: 6246, ui: true, home: "https://maintainerr.info", licence: "MIT", needs: "Plex or Jellyfin" },
};
const NAMES = Object.keys(CATALOG);
const KEY = "addons.state";
const port = z.number().int().min(1024).max(65535);
interface One { port: number; autostart: boolean }
const oneSchema = z.object({ port: port.catch(0), autostart: z.boolean().catch(true) });
async function readStored(): Promise<Record<string, One>> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  let raw: Record<string, unknown> = {}; try { const value = JSON.parse(row?.value ?? "{}") as unknown; if (value && typeof value === "object") raw = value as Record<string, unknown>; } catch { /* start again */ }
  return Object.fromEntries(NAMES.map(name => { const one = oneSchema.parse(raw[name] ?? {}); return [name, { port: one.port || CATALOG[name].port, autostart: one.autostart }]; }));
}
const writeStored = (value: Record<string, One>) => db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });

type State = "absent" | "stopped" | "running" | "pulling" | "starting" | "failed" | "unknown";
type HelperServer = { state: State; port?: number; error?: string; autostart?: boolean };
async function helperStatus(): Promise<Record<string, HelperServer> | null> {
  if (dockerControl().mode === "off") return null;
  try { return (await manager<{ servers: Record<string, HelperServer> }>("GET", "/status")).servers; } catch { return null; }
}

export async function addonsView() {
  const [stored, status] = await Promise.all([readStored(), helperStatus()]), control = dockerControl();
  return {
    control: { mode: control.mode, reason: control.reason }, groups: GROUPS,
    addons: NAMES.map(name => {
      const entry = CATALOG[name], found = status?.[name];
      return { name, label: entry.label, group: entry.group, blurb: entry.blurb, home: entry.home, licence: entry.licence, ui: entry.ui, needs: entry.needs ?? null,
        state: (found?.state ?? (status ? "absent" : "unknown")) as State, port: found?.port ?? stored[name].port, autostart: found?.autostart ?? stored[name].autostart, error: found?.state === "failed" ? found.error ?? null : null };
    }),
  };
}

export const addonsRouter = Router();
addonsRouter.use(requireAuth, requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
addonsRouter.param("addon", (_req, res, next, value: string) => { if (NAMES.includes(value)) next(); else res.status(404).json({ error: "Unknown add-on." }); });
const guard = (run: Parameters<typeof asyncHandler>[0]) => asyncHandler(async (req, res, next) => {
  try { await run(req, res, next); } catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
});
const limit = rateLimit({ windowMs: 60_000, max: 30 });
addonsRouter.get("/", guard(async (_req, res) => { res.json(await addonsView()); }));
/** Install it, or start it again: made from the same fixed specification each time, so its settings under config/ carry over. */
addonsRouter.post("/:addon/launch", limit, guard(async (req, res) => {
  const name = req.params.addon as string;
  const body = parseBody(z.object({ port: port.optional(), autostart: z.boolean().optional() }).strict(), req.body ?? {}, res); if (!body) return;
  const stored = await readStored();
  if (body.port !== undefined) stored[name].port = body.port;
  if (body.autostart !== undefined) stored[name].autostart = body.autostart;
  await writeStored(stored);
  if (name === "prowlarr") {
    if (await requestProwlarr() === "unavailable") { res.status(409).json({ error: "Starting add-ons from here needs Docker control, which is off on this server (see Admin → System)." }); return; }
  } else await manager("POST", `/servers/${name}/launch`, { port: stored[name].port, autostart: stored[name].autostart });
  void logEvent("info", "admin_action", `Started ${CATALOG[name].label}`, { userId: req.session!.sub, meta: { port: stored[name].port } }).catch(() => undefined);
  res.status(202).json(await addonsView());
}));
addonsRouter.post("/:addon/stop", limit, guard(async (req, res) => {
  const name = req.params.addon as string;
  await manager("POST", `/servers/${name}/stop`);
  void logEvent("info", "admin_action", `Stopped ${CATALOG[name].label}`, { userId: req.session!.sub }).catch(() => undefined);
  res.json(await addonsView());
}));
/** Remove the container; what it keeps under config/ stays, so installing it again picks up where it was. */
addonsRouter.delete("/:addon", limit, guard(async (req, res) => {
  const name = req.params.addon as string;
  if (name === "prowlarr") await removeProwlarr(); else await manager("DELETE", `/servers/${name}`);
  void logEvent("info", "admin_action", `Removed ${CATALOG[name].label}`, { userId: req.session!.sub }).catch(() => undefined);
  res.json(await addonsView());
}));
addonsRouter.put("/:addon/autostart", limit, guard(async (req, res) => {
  const name = req.params.addon as string;
  const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body, res); if (!body) return;
  const stored = await readStored(); stored[name].autostart = body.enabled; await writeStored(stored);
  const status = await helperStatus();
  if (status?.[name] && ["running", "stopped"].includes(status[name].state)) await manager("POST", `/servers/${name}/autostart`, { enabled: body.enabled });
  res.json(await addonsView());
}));
addonsRouter.get("/:addon/logs", rateLimit({ windowMs: 60_000, max: 120 }), guard(async (req, res) => {
  const query = parseBody(z.object({ tail: z.coerce.number().int().min(1).max(200).default(100) }).strict(), req.query, res); if (!query) return;
  res.json(await manager<{ deploy: unknown[]; container: string[] }>("GET", `/servers/${req.params.addon}/logs?tail=${query.tail}`));
}));
