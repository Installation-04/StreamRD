import os from "node:os";
import { Prisma } from "@prisma/client";
import { Request, Router } from "express";
import { version } from "../../package.json";
import { db } from "../db";
import { asyncHandler } from "../http";
import { logEvent } from "../logger";
import { checkForUpdates, listBackups, pendingRestore } from "../maintenance";
import { PRODUCT } from "../product";
import { rateLimit } from "../util/rateLimit";

/**
 * Admin → Logs: one stream of what the server did, newest first.
 * It joins two sources, so that a workflow can be followed from one place:
 *   - LogEvent: sign-ins, playback, provider errors, administrator actions, system events;
 *   - RequestEvent: every step of a media request (received, approved, release chosen, submitted, progress, available, failed),
 *     shown as type "request" with the request's id and title, so searching a title or an id shows its whole history.
 * Nothing is written twice: request steps are read from where the request workflow already records them.
 * Mounted under /api/admin/logs by each product's admin router, which enforces administrator access.
 */
export interface LogLine { id: string; createdAt: Date; level: string; type: string; message: string; userId: string | null; provider: string | null; meta: string | null }

const LOG_LEVELS = new Set(["info", "warn", "error"]);
const LOG_TYPE = /^[a-z_]{1,40}$/;
const REQUEST_LEVEL: Record<string, string> = { failed: "error", attention: "warn", rejected: "warn", cancelled: "warn" };
const levelStatuses = (level: string) => level === "info" ? { notIn: Object.keys(REQUEST_LEVEL) } : { in: Object.keys(REQUEST_LEVEL).filter(status => REQUEST_LEVEL[status] === level) };
class BadLogRequest extends Error {}
interface Filters { events: Prisma.LogEventWhereInput | null; requests: Prisma.RequestEventWhereInput | null }

function logFilters(query: Request["query"]): Filters {
  const events: Prisma.LogEventWhereInput = {}, requests: Prisma.RequestEventWhereInput = {};
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const type = text(query.type, 40), level = text(query.level, 10), provider = text(query.provider, 40), userId = text(query.userId, 100), q = text(query.q, 200);
  let withEvents = true, withRequests = true;
  if (type) { if (type === "request") withEvents = false; else { withRequests = false; events.type = LOG_TYPE.test(type) ? type : "\u0000no-such-type"; } }
  if (level) { if (LOG_LEVELS.has(level)) { events.level = level; requests.status = levelStatuses(level); } else { events.level = "\u0000no-such-level"; withRequests = false; } }
  if (provider) { events.provider = provider; requests.request = { providerId: provider }; }
  if (userId) { events.userId = userId; withRequests = false; }   // request steps record no acting account
  if (q) {
    events.OR = [{ message: { contains: q } }, { meta: { contains: q } }];
    requests.OR = [{ message: { contains: q } }, { requestId: q }, { request: { name: { contains: q } } }];
  }
  const range: Prisma.DateTimeFilter = {};
  for (const [key, field] of [["from", "gte"], ["to", "lte"]] as const) {
    const raw = text(query[key], 40);
    if (!raw) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new BadLogRequest(`Invalid ${key} date.`);
    range[field] = date;
  }
  if (range.gte || range.lte) { events.createdAt = range; requests.createdAt = range; }
  return { events: withEvents ? events : null, requests: withRequests ? requests : null };
}
const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(JSON.stringify([row.createdAt.getTime(), row.id])).toString("base64url");
function decodeCursor(raw: unknown): { OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] } | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Number.isFinite(at) || typeof id !== "string" || id.length > 100) throw new Error();
    const date = new Date(at);
    return { OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: id } }] };
  } catch { throw new BadLogRequest("Invalid page cursor."); }
}
const order = [{ createdAt: "desc" as const }, { id: "desc" as const }];
/** One page of the joined stream. Both sources are read newest first from the same cursor and merged, so paging never skips or repeats a line. */
async function logPage(where: Filters, cursor: ReturnType<typeof decodeCursor>, take: number): Promise<{ page: LogLine[]; nextCursor: string | null }> {
  const [events, steps] = await Promise.all([
    where.events ? db.logEvent.findMany({ where: cursor ? { AND: [where.events, cursor] } : where.events, orderBy: order, take: take + 1 }) : [],
    where.requests ? db.requestEvent.findMany({ where: cursor ? { AND: [where.requests, cursor] } : where.requests, orderBy: order, take: take + 1,
      include: { request: { select: { name: true, year: true, mediaType: true, providerId: true, destination: true } } } }) : [],
  ]);
  const rows: LogLine[] = [...events, ...steps.map(step => ({
    id: step.id, createdAt: step.createdAt, level: REQUEST_LEVEL[step.status] ?? "info", type: "request", userId: null, provider: step.request.providerId,
    message: `${step.request.name}${step.request.year ? ` (${step.request.year})` : ""}: ${step.message}`,
    meta: JSON.stringify({ requestId: step.requestId, status: step.status, progress: step.progress, mediaType: step.request.mediaType, destination: step.request.destination }),
  }))].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const page = rows.slice(0, take);
  return { page, nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null };
}
const parseMeta = (value: string | null) => { if (!value) return null; try { return JSON.parse(value); } catch { return value; } };

/**
 * Takes out what must not leave the server in a file that is handed to someone else: links (the host is kept, since it says which service
 * failed), magnets, e-mail addresses, credentials in a query string or a header, and anything long enough to be a key or a token.
 */
export function redact(text: string): string {
  return text
    .replace(/magnet:\?[^\s"'<>]+/gi, "<magnet>")
    .replace(/\b(https?:\/\/)(?:[^\s/@"'<>]+@)?([^\s/?#"'<>]+)[^\s"'<>]*/gi, (_all, scheme: string, host: string) => `${scheme}${host}/<…>`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b(authorization|token|api[_-]?key|apikey|password|passwd|secret|cookie)(["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;&]+/gi, "$1$2<secret>")
    .replace(/\b(bearer)\s+[^\s"',;&]+/gi, "$1 <secret>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<secret>");
}
const redactDeep = (value: unknown): unknown => typeof value === "string" ? redact(value) : Array.isArray(value) ? value.map(redactDeep)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactDeep(inner)])) : value;

/** What the update helper last did (pull, replace, health check, rollback). Null when no helper is set up or it does not answer. */
export async function updateHelperLog(): Promise<{ state: string; error: string; startedAt: string | null; finishedAt: string | null; log: Array<{ time: string; message: string }> } | null> {
  const base = (process.env.MEDIA_MANAGER_URL ?? "").replace(/\/+$/, ""), token = process.env.MEDIA_MANAGER_TOKEN ?? "";
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base}/update`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000), redirect: "error" });
    if (!response.ok) return null;
    const body = await response.json() as { state?: unknown; error?: unknown; startedAt?: unknown; finishedAt?: unknown; log?: unknown };
    const lines = Array.isArray(body.log) ? body.log.filter((line): line is { time: string; message: string } => !!line && typeof line.time === "string" && typeof line.message === "string").slice(-200) : [];
    return { state: String(body.state ?? "unknown").slice(0, 20), error: String(body.error ?? "").slice(0, 300), startedAt: typeof body.startedAt === "string" ? body.startedAt : null,
      finishedAt: typeof body.finishedAt === "string" ? body.finishedAt : null, log: lines.map(line => ({ time: line.time.slice(0, 40), message: line.message.slice(0, 300) })) };
  } catch { return null; }
}
const UPDATE_RECORDED = "logs.lastRecordedUpdate";
/**
 * Called at start. An update replaces this container, so the server that asked for it never sees how it went. The helper does:
 * its account of the last update (or rollback) is copied into the log here, once, where it can be searched and exported with everything else.
 * Returns "pending" while the update is still being finished: the new version has started but is not yet confirmed healthy.
 */
export async function recordUpdateOutcome(): Promise<boolean | "pending"> {
  const helper = await updateHelperLog();
  if (helper?.state === "running") return "pending";
  if (!helper || !helper.finishedAt || !["done", "failed", "current"].includes(helper.state)) return false;
  const seen = await db.setting.findUnique({ where: { key: UPDATE_RECORDED } });
  if (seen && seen.value === JSON.stringify(helper.finishedAt)) return false;
  await db.setting.upsert({ where: { key: UPDATE_RECORDED }, create: { key: UPDATE_RECORDED, value: JSON.stringify(helper.finishedAt) }, update: { value: JSON.stringify(helper.finishedAt) } });
  const message = helper.state === "done" ? `Update finished; now running ${version}.` : helper.state === "current" ? "Update checked: the newest image was already running."
    : `Update failed and the previous version was put back (now running ${version}): ${helper.error || "no reason was given"}`;
  await logEvent(helper.state === "failed" ? "error" : "info", "system", message, { meta: { update: { state: helper.state, startedAt: helper.startedAt, finishedAt: helper.finishedAt, steps: helper.log } } });
  return true;
}

/** Records the outcome now, or as soon as the update that started this server has been confirmed (checked every few seconds, for ten minutes). */
export function recordUpdateOutcomeWhenKnown(everyMs = 10_000, tries = 60): void {
  const attempt = (left: number) => { void recordUpdateOutcome().then(result => { if (result === "pending" && left > 0) setTimeout(() => attempt(left - 1), everyMs).unref(); }, () => undefined); };
  attempt(tries);
}

export const logsRouter = Router();
const guard = (handler: (req: Request, res: Parameters<Parameters<typeof asyncHandler>[0]>[1]) => Promise<unknown>) => asyncHandler(async (req, res) => {
  try { await handler(req, res); } catch (error) { if (error instanceof BadLogRequest) { res.status(400).json({ error: error.message }); return; } throw error; }
});
logsRouter.get("/", guard(async (req, res) => {
  const take = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 1000);
  const { page, nextCursor } = await logPage(logFilters(req.query), decodeCursor(req.query.cursor), take);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ logs: page, nextCursor });
}));

const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  // A leading = + - @ or control character would run as a formula in spreadsheet software.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const EXPORT_FORMATS = { ndjson: { ext: "ndjson", type: "application/x-ndjson" }, csv: { ext: "csv", type: "text/csv" }, txt: { ext: "log", type: "text/plain" } } as const;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
logsRouter.get("/export", rateLimit({ windowMs: 60_000, max: 10 }), guard(async (req, res) => {
  const format = String(req.query.format ?? "ndjson") as keyof typeof EXPORT_FORMATS;
  if (!Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, format)) { res.status(400).json({ error: "Choose ndjson, csv or txt." }); return; }
  const where = logFilters(req.query);
  const cap = Math.min(Math.max(parseInt(String(req.query.max ?? "10000"), 10) || 10000, 1), 50000);
  res.setHeader("Content-Type", `${EXPORT_FORMATS[format].type}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename="${PRODUCT.id}-logs-${stamp()}.${EXPORT_FORMATS[format].ext}"`);
  res.setHeader("Cache-Control", "private, no-store");
  if (format === "csv") res.write("time,level,type,provider,userId,message,meta\r\n");
  let sent = 0, cursor: ReturnType<typeof decodeCursor> = null;
  while (sent < cap) {
    const { page, nextCursor } = await logPage(where, cursor, Math.min(1000, cap - sent));
    for (const row of page) {
      const when = row.createdAt.toISOString(), details = parseMeta(row.meta);
      if (format === "ndjson") res.write(JSON.stringify({ time: when, level: row.level, type: row.type, provider: row.provider, userId: row.userId, message: row.message, meta: details }) + "\n");
      else if (format === "csv") res.write([when, row.level, row.type, row.provider, row.userId, row.message, details === null ? "" : JSON.stringify(details)].map(csvCell).join(",") + "\r\n");
      else res.write(`${when} ${row.level.toUpperCase().padEnd(5)} ${row.type}${row.provider ? ` [${row.provider}]` : ""} ${row.message.replace(/\r?\n/g, " ")}${details === null ? "" : " " + JSON.stringify(details)}\n`);
    }
    sent += page.length;
    if (!nextCursor || !page.length) break;
    cursor = decodeCursor(nextCursor);
  }
  res.end();
  void logEvent("info", "admin_action", "Exported logs", { userId: req.session?.sub, meta: { format, rows: sent } });
}));

/**
 * One file to attach to a bug report: what is running, how it is set up (never the values of credentials), the last update, requests that are
 * stuck or failed with their history, and the recent log. Everything passes through redact().
 */
logsRouter.get("/bundle", rateLimit({ windowMs: 60_000, max: 6 }), guard(async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? "7"), 10) || 7, 1), 90), since = new Date(Date.now() - days * 86_400_000);
  const on = (name: string) => { const value = process.env[name]; return value === undefined || value === "" ? "default" : ["0", "false", "off", "no"].includes(value.toLowerCase()) ? "off" : "set"; };
  const [update, helper, users, admins, logCounts, requestCounts, troubled, { page }] = await Promise.all([
    checkForUpdates().catch(() => null), updateHelperLog(), db.user.count(), db.user.count({ where: { role: "admin" } }),
    db.logEvent.groupBy({ by: ["type", "level"], where: { createdAt: { gte: since } }, _count: true }),
    db.mediaRequest.groupBy({ by: ["status"], _count: true }),
    db.mediaRequest.findMany({ where: { OR: [{ status: { in: ["failed", "attention"] } }, { status: { notIn: ["available", "rejected", "cancelled", "requested"] }, updatedAt: { lt: new Date(Date.now() - 6 * 3_600_000) } }] }, orderBy: { updatedAt: "desc" }, take: 25,
      select: { id: true, name: true, year: true, mediaType: true, status: true, destination: true, providerId: true, downloadState: true, progress: true, error: true, attempts: true, createdAt: true, updatedAt: true,
        events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: { createdAt: true, status: true, message: true, progress: true } } } }),
    logPage({ events: { createdAt: { gte: since } }, requests: { createdAt: { gte: since } } }, null, 5000),
  ]);
  const backups = (() => { try { return listBackups().slice(0, 20).map(({ kind, sizeBytes, createdAt }) => ({ kind, sizeBytes, createdAt })); } catch { return []; } })();
  const bundle = redactDeep({
    generatedAt: new Date().toISOString(), product: PRODUCT.id, version, days,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), cpus: os.cpus().length, container: Boolean(process.env.CONFIG_DIR || process.env.DATA_DIR) },
    settings: Object.fromEntries(["TRANSCODE", "TRANSCODE_VIDEO", "TRANSCODE_MAX", "TRANSCODE_ALLOW_PRIVATE_HOSTS", "UPDATE_CHECK", "UPDATE_WEBHOOK_URL", "MEDIA_MANAGER_URL", "ADMIN_RESTART", "TRUST_PROXY", "CORS_ORIGINS", "PUBLIC_URL", "ZILEAN_URL", "TMDB_DEFAULT_API_KEY"].map(name => [name, on(name)])),
    update: update ? { current: update.current, latest: update.latest, updateAvailable: update.updateAvailable, checkedAt: update.checkedAt, error: update.error, updater: update.updater } : null,
    lastUpdate: helper, pendingRestore: pendingRestore() ? { requestedAt: pendingRestore()!.requestedAt } : null, backups,
    accounts: { users, admins },
    logCounts: logCounts.map(row => ({ type: row.type, level: row.level, count: row._count })),
    requestCounts: Object.fromEntries(requestCounts.map(row => [row.status, row._count])),
    requestsNeedingAttention: troubled,
    logs: page.map(row => ({ time: row.createdAt.toISOString(), level: row.level, type: row.type, provider: row.provider, userId: row.userId, message: row.message, meta: parseMeta(row.meta) })),
  });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${PRODUCT.id}-diagnostics-${stamp()}.json"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(JSON.stringify(bundle, null, 2));
  void logEvent("info", "admin_action", "Downloaded a diagnostic bundle", { userId: req.session?.sub, meta: { days, lines: page.length } });
}));
