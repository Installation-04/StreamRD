import { Router } from "express";
import { z } from "zod";
import { db } from "./db";
import { logEvent } from "./logger";
import { asyncHandler } from "./http";
import { requireAdmin, requireAuth } from "./auth/middleware";
import { parseBody } from "./routes/helpers";
import { dockerControl } from "./maintenance";
import { manager, ManagerError } from "./media-servers";
import { rateLimit } from "./util/rateLimit";

/**
 * The programs StreamRD runs next to itself (Prowlarr, Jellyfin, Plex) have their own releases, and a StreamRD release is not the way
 * they get newer. From here an administrator checks whether a newer version of one exists and updates it; the Docker helper does the work:
 * it downloads the image the module's fixed reference points to now, and when that is not the image running, makes the container again
 * from the same specification (same port, same folders), keeping the old container until the new one runs and putting it back if it does not.
 *
 * Each module can also be left to update itself, at night (between 03:00 and 05:00, the server's time zone, at most once a day), which is
 * off until it is turned on: an update restarts the module, and a media server that is playing something stops playing it.
 */
export const MODULES = {
  prowlarr: { label: "Prowlarr", what: "keeps the indexers that requests search" },
  jellyfin: { label: "Jellyfin", what: "media server" },
  plex: { label: "Plex", what: "media server" },
} as const;
export type ModuleName = keyof typeof MODULES;
const NAMES = Object.keys(MODULES) as ModuleName[];
export const AUTO_WINDOW = { from: 3, to: 5 } as const;
const KEY = "modules.state", RAN = "modules.autoRan";

interface One { auto: boolean; checkedAt: string | null; available: boolean; availableVersion: string | null; updatedAt: string | null }
type Stored = Record<ModuleName, One>;
const blank = (): One => ({ auto: false, checkedAt: null, available: false, availableVersion: null, updatedAt: null });
const date = z.string().refine(value => !Number.isNaN(Date.parse(value))).nullable().catch(null);
const oneSchema = z.object({ auto: z.boolean().catch(false), checkedAt: date, available: z.boolean().catch(false), availableVersion: z.string().max(60).nullable().catch(null), updatedAt: date }).catch(blank());
async function readStored(): Promise<Stored> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  let raw: Record<string, unknown> = {}; try { const value = JSON.parse(row?.value ?? "{}") as unknown; if (value && typeof value === "object") raw = value as Record<string, unknown>; } catch { /* start again */ }
  return Object.fromEntries(NAMES.map(name => [name, oneSchema.parse(raw[name] ?? {})])) as Stored;
}
const writeStored = (value: Stored) => db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });

interface Release { version: string; created: string }
/** What the helper says about a module's last check or update, and the image it runs now. */
interface HelperUpdate { state: "idle" | "running" | "current" | "available" | "updated" | "failed"; apply?: boolean; step?: string; error?: string; startedAt?: string | null; finishedAt?: string | null; current: Release | null; available?: Release | null }
type HelperServer = { state: string };
async function helperStatus(): Promise<Record<string, HelperServer> | null> {
  if (dockerControl().mode === "off") return null;
  try { return (await manager<{ servers: Record<string, HelperServer> }>("GET", "/status")).servers; } catch { return null; }
}
async function helperUpdate(name: ModuleName): Promise<HelperUpdate | null> {
  try { return await manager<HelperUpdate>("GET", `/servers/${name}/update`); } catch { return null; }
}

/**
 * Keeps what the helper found: when a check or an update has finished, whether a newer version exists and when it was done. The helper
 * only remembers this until it restarts, and the page may not be open when a night's update finishes, so it is read from here and kept.
 */
async function remember(name: ModuleName, stored: Stored, update: HelperUpdate | null): Promise<boolean> {
  if (!update || !update.finishedAt || !["current", "available", "updated"].includes(update.state)) return false;
  const one = stored[name], at = Date.parse(update.finishedAt), previous = one.checkedAt ? Date.parse(one.checkedAt) : 0;
  if (!(at > previous)) return false;   // nothing newer than what is kept already
  one.checkedAt = update.finishedAt;
  one.available = update.state === "available";
  one.availableVersion = update.state === "available" ? (update.available?.version || null) : null;
  if (update.state === "updated") { one.updatedAt = update.finishedAt; void logEvent("info", "system", `${MODULES[name].label} was updated${update.current?.version ? ` to ${update.current.version}` : ""}`).catch(() => undefined); }
  return true;
}
/** Reads every present module's outcome from the helper and keeps it. Returns what it read, to save asking twice. */
async function observe(stored: Stored, status: Record<string, HelperServer>): Promise<Partial<Record<ModuleName, HelperUpdate | null>>> {
  const updates: Partial<Record<ModuleName, HelperUpdate | null>> = {};
  let changed = false;
  await Promise.all(NAMES.map(async name => {
    if (!status[name] || status[name].state === "absent") return;
    updates[name] = await helperUpdate(name);
    if (await remember(name, stored, updates[name]!)) changed = true;
  }));
  if (changed) await writeStored(stored);
  return updates;
}

export async function modulesView() {
  const control = dockerControl(), stored = await readStored(), status = await helperStatus();
  const updates = status ? await observe(stored, status) : {};
  return {
    control: { mode: control.mode, reason: control.reason }, window: { from: AUTO_WINDOW.from, to: AUTO_WINDOW.to, timezone: process.env.TZ || "UTC" },
    modules: NAMES.map(name => {
      const server = status?.[name], update = updates[name] ?? null, one = stored[name];
      return {
        name, label: MODULES[name].label, what: MODULES[name].what,
        state: server?.state ?? (status ? "absent" : "unknown"),
        version: update?.current?.version || null, built: update?.current?.created || null,
        update: update && update.state !== "idle" ? { state: update.state, apply: update.apply === true, step: update.step ?? "", error: update.error ?? "" } : null,
        updateAvailable: one.available, availableVersion: one.availableVersion, checkedAt: one.checkedAt, updatedAt: one.updatedAt, auto: one.auto,
      };
    }),
  };
}

const localDay = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
/**
 * The night's updates: for every module that is set to update itself and is running, check for a newer version and update to it. Runs at
 * most once a day, inside the window. A night the helper cannot be reached does not count; the next tick tries again.
 */
export async function runAutomaticUpdates(now = new Date()): Promise<ModuleName[]> {
  const hour = now.getHours();
  if (hour < AUTO_WINDOW.from || hour >= AUTO_WINDOW.to) return [];
  const day = localDay(now);
  if ((await db.setting.findUnique({ where: { key: RAN } }))?.value === day) return [];
  const stored = await readStored(), wanted = NAMES.filter(name => stored[name].auto);
  if (!wanted.length) return [];
  const status = await helperStatus(); if (!status) return [];
  const started: ModuleName[] = [];
  for (const name of wanted) {
    if (status[name]?.state !== "running") continue;
    try { await manager("POST", `/servers/${name}/update`, { apply: true }); started.push(name); void logEvent("info", "system", `Checking ${MODULES[name].label} for a newer version (nightly update)`).catch(() => undefined); }
    catch (error) { void logEvent("warn", "system", `The nightly update of ${MODULES[name].label} could not start: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 300)).catch(() => undefined); }
  }
  await db.setting.upsert({ where: { key: RAN }, create: { key: RAN, value: day }, update: { value: day } });
  return started;
}
let timer: ReturnType<typeof setInterval> | undefined;
/** Every half hour: note how the last updates went (so a night's update is recorded without anyone opening the page), then the night's run. */
export function startModuleUpdates(everyMs = 30 * 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      const status = await helperStatus();
      if (status) { const stored = await readStored(); await observe(stored, status); }
      await runAutomaticUpdates();
    })().catch(() => undefined);
  }, everyMs);
  timer.unref();
}

export const modulesRouter = Router();
modulesRouter.use(requireAuth, requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
modulesRouter.param("module", (_req, res, next, value: string) => { if ((NAMES as readonly string[]).includes(value)) next(); else res.status(404).json({ error: "Unknown module." }); });
const limit = rateLimit({ windowMs: 60_000, max: 30 });
const guard = (run: Parameters<typeof asyncHandler>[0]) => asyncHandler(async (req, res, next) => {
  try { await run(req, res, next); } catch (error) { if (error instanceof ManagerError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
});
modulesRouter.get("/", guard(async (_req, res) => { res.json(await modulesView()); }));
/** Download the newest image and say whether it is newer than the one running; nothing is changed. */
modulesRouter.post("/:module/check", limit, guard(async (req, res) => {
  const name = req.params.module as ModuleName;
  await manager("POST", `/servers/${name}/update`, { apply: false });
  res.status(202).json(await modulesView());
}));
/** Update now: download the newest image and, if it is newer, run the module from it. */
modulesRouter.post("/:module/update", limit, guard(async (req, res) => {
  const name = req.params.module as ModuleName;
  await manager("POST", `/servers/${name}/update`, { apply: true });
  void logEvent("info", "admin_action", `Started updating ${MODULES[name].label}`, { userId: req.session!.sub }).catch(() => undefined);
  res.status(202).json(await modulesView());
}));
modulesRouter.put("/:module/auto", limit, guard(async (req, res) => {
  const name = req.params.module as ModuleName;
  const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body, res); if (!body) return;
  const stored = await readStored(); stored[name].auto = body.enabled; await writeStored(stored);
  void logEvent("info", "admin_action", `${MODULES[name].label} ${body.enabled ? "updates itself at night" : "no longer updates itself"}`, { userId: req.session!.sub }).catch(() => undefined);
  res.json(await modulesView());
}));
