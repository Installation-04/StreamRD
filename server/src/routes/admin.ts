import { AccessError } from "../auth/access";
import { accessRouter } from "./access";
import { protectCatalogEdits } from "../metadata/automation";
import { getMetadataSettings, providerConfigured } from "../metadata/settings";
import { metadataSelectionSchema } from "./metadata";
import { asyncHandler } from "../http";
import { Prisma } from "@prisma/client";
import { Request, Router } from "express";
import { rateLimit } from "../util/rateLimit";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { db } from "../db";
import { logEvent } from "../logger";
import { playbackStats, snapshotCounters } from "../metrics";
import { debridManager } from "../providers/manager";
import { getProvider, providers } from "../providers/registry";
import { PROVIDER_IDS, ProviderId } from "../providers/types";
import {
  getProviderSettings,
  getServerSettings,
  saveProviderSettings,
  saveServerSettings,
} from "../settings";
import { LIMIT_AGES } from "../ratings";
import { parseBody, publicTitle, publicUser } from "./helpers";

export const adminRouter = Router();
// Every /api/admin/* route requires an authenticated admin. RBAC tests
// assert both the 401 (no session) and 403 (non-admin) paths.
adminRouter.use(requireAuth, requireAdmin);
adminRouter.use(accessRouter);

/* ------------------------------ users ------------------------------ */

adminRouter.get("/users", asyncHandler(async (_req, res) => {
  const users = await db.user.findMany({ orderBy: { createdAt: "asc" }, take: 5000 });
  res.json({ users: users.map(publicUser) });
}));

adminRouter.get("/users/:id", asyncHandler(async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.params.id },
    include: { playbackLogs: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const { playbackLogs, ...rest } = user;
  res.json({ user: publicUser(rest), recentPlaybacks: playbackLogs });
}));

const userUpdateSchema = z.object({
  role: z.enum(["user", "admin"]).optional(),
  active: z.boolean().optional(),
  displayName: z.string().min(1).max(80).optional(),
  // The highest minimum age this person may see (7 kids, 8 pre-teens, 14 teens, 17 mature); null removes the limit.
  maxAge: z.number().int().refine(age => LIMIT_AGES.includes(age)).nullable().optional(),
});

adminRouter.patch("/users/:id", asyncHandler(async (req, res) => {
  const body = parseBody(userUpdateSchema, req.body, res);
  if (!body) return;
  // Guard rail: an admin cannot demote or deactivate themselves, which
  // otherwise makes it easy to lock every admin out of the panel.
  if (
    req.params.id === req.session!.sub &&
    (body.role === "user" || body.active === false)
  ) {
    res.status(400).json({ error: "You cannot demote or deactivate your own account" });
    return;
  }
  let user;
  try {
    user = await db.$transaction(async tx => {
      // Serialize actor checks and target changes. Two administrators cannot
      // simultaneously remove one another and leave the server without an admin.
      await tx.setting.upsert({ where: { key: "auth.admin.users.lock" }, create: { key: "auth.admin.users.lock", value: "1" }, update: { value: "1" } });
      const actor = await tx.user.findFirst({
        where: { id: req.session!.sub, active: true, sessionVersion: req.session!.version, revokedSessions: { none: { id: req.session!.jti } } },
        select: { role: true },
      });
      if (!actor || req.session!.exp * 1000 <= Date.now()) throw new AccessError(401, "Session is no longer active");
      if (actor.role !== "admin") throw new AccessError(403, "Admin role required");
      const existing = await tx.user.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AccessError(404, "User not found");
      if (existing.active && existing.role === "admin" && (body.role === "user" || body.active === false)) {
        const admins = await tx.user.count({ where: { active: true, role: "admin" } });
        if (admins <= 1) throw new AccessError(409, "The server must retain at least one active administrator");
      }
      return tx.user.update({ where: { id: existing.id }, data: { ...body, ...(body.active === false ? { sessionVersion: { increment: 1 } } : {}) } });
    }, { maxWait: 10000, timeout: 10000 });
  } catch (error) {
    if (error instanceof AccessError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }
  await logEvent("info", "admin_action", `Updated user ${user.email}`, {
    userId: req.session!.sub,
    meta: body,
  });
  res.json({ user: publicUser(user) });
}));

/* ----------------------------- catalog ----------------------------- */

adminRouter.get("/catalog", asyncHandler(async (_req, res) => {
  const titles = await db.title.findMany({ orderBy: { createdAt: "desc" }, take: 5000 });
  res.json({ titles: titles.map((t) => publicTitle(t, { includeSources: true })) });
}));

const sourceSchema = z.object({
  kind: z.enum(["link", "magnet"]),
  url: z.string().min(1),
  quality: z.string().optional(),
  label: z.string().optional(),
});

const titleSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  type: z.enum(["movie", "series"]).default("movie"),
  genres: z.array(z.string()).default([]),
  year: z.number().int().nullable().optional(),
  posterUrl: z.string().url().nullable().optional(),
  backdropUrl: z.string().url().nullable().optional(),
  sources: z.array(sourceSchema).default([]),
});

function titleData(body: z.infer<typeof titleSchema>) {
  return {
    name: body.name,
    description: body.description,
    type: body.type,
    genres: JSON.stringify(body.genres),
    year: body.year ?? null,
    posterUrl: body.posterUrl ?? null,
    backdropUrl: body.backdropUrl ?? null,
    sources: JSON.stringify(body.sources),
  };
}

adminRouter.post("/catalog/create", asyncHandler(async (req, res) => {
  const body = parseBody(titleSchema.extend({ metadataMatch: metadataSelectionSchema.optional() }), req.body, res);
  if (!body) return;
  const preferences = await getMetadataSettings();
  if (body.metadataMatch && (body.metadataMatch.type !== body.type || !providerConfigured(preferences, body.metadataMatch.provider))) {
    res.status(400).json({ error: "Configure the chosen metadata provider and use the same movie/series type before saving a match" }); return;
  }
  const metadataQueued = Boolean(body.metadataMatch || preferences.automatic);
  const title = await db.$transaction(async tx => {
    const created = await tx.title.create({ data: titleData(body) });
    if (metadataQueued) await tx.metadataRecord.create({ data: { targetType: "catalog", targetId: created.id, name: created.name, mediaType: created.type, year: created.year,
      requestedBy: body.metadataMatch ? "manual" : "automatic", ...(body.metadataMatch ? { data: JSON.stringify({ selection: body.metadataMatch }) } : {}) } });
    return created;
  });
  await logEvent("info", "admin_action", `Created title "${title.name}"`, {
    userId: req.session!.sub,
  });
  res.status(201).json({ title: publicTitle(title, { includeSources: true }), metadataQueued });
}));

adminRouter.patch("/catalog/:id/update", asyncHandler(async (req, res) => {
  const body = parseBody(titleSchema.partial(), req.body, res);
  if (!body) return;
  const existing = await db.title.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "Title not found" });
    return;
  }
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description;
  if (body.type !== undefined) data.type = body.type;
  if (body.genres !== undefined) data.genres = JSON.stringify(body.genres);
  if (body.year !== undefined) data.year = body.year;
  if (body.posterUrl !== undefined) data.posterUrl = body.posterUrl;
  if (body.backdropUrl !== undefined) data.backdropUrl = body.backdropUrl;
  if (body.sources !== undefined) data.sources = JSON.stringify(body.sources);
  const title = await db.$transaction(async tx => {
    const fields = Object.keys(data).filter(field => data[field] !== existing[field as keyof typeof existing]);
    const identityChanged = ["name", "type", "year"].some(field => fields.includes(field));
    await protectCatalogEdits(existing.id, fields, identityChanged, tx);
    return tx.title.update({ where: { id: req.params.id }, data });
  });
  res.json({ title: publicTitle(title, { includeSources: true }) });
}));

adminRouter.delete("/catalog/:id/delete", asyncHandler(async (req, res) => {
  const existing = await db.title.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "Title not found" });
    return;
  }
  await db.$transaction([db.metadataRecord.deleteMany({ where: { targetType: "catalog", targetId: req.params.id } }), db.title.delete({ where: { id: req.params.id } })]);
  await logEvent("info", "admin_action", `Deleted title "${existing.name}"`, {
    userId: req.session!.sub,
  });
  res.json({ ok: true });
}));

/* -------------------------- server settings ------------------------ */

adminRouter.get("/server", asyncHandler(async (_req, res) => {
  res.json({ settings: await getServerSettings() });
}));

const serverSettingsSchema = z.object({
  providerOrder: z.array(z.enum(PROVIDER_IDS)),
  disabledProviders: z.array(z.enum(PROVIDER_IDS)),
  providerTimeoutMs: z.number().int().min(1000).max(120000),
  maxPlaybackAttempts: z.number().int().min(1).max(10),
  allowUnauthenticatedBrowse: z.boolean(),
  requireLoginForPlayback: z.boolean(),
});

adminRouter.put("/server", asyncHandler(async (req, res) => {
  const current = await getServerSettings();
  const body = parseBody(serverSettingsSchema.partial(), req.body, res);
  if (!body) return;
  const merged = { ...current, ...body };
  await saveServerSettings(merged);
  await logEvent("info", "admin_action", "Updated server settings", {
    userId: req.session!.sub,
    meta: body,
  });
  res.json({ settings: merged });
}));

/* ------------------------- provider settings ----------------------- */

adminRouter.get("/providers", asyncHandler(async (_req, res) => {
  const settings = await getProviderSettings();
  res.json({
    providers: PROVIDER_IDS.map((id) => ({
      id,
      displayName: providers[id].displayName,
      enabled: settings[id]?.enabled !== false,
      baseUrl: settings[id]?.baseUrl ?? null,
    })),
  });
}));

const providerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().nullable().optional(),
});

adminRouter.put("/providers/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as ProviderId;
  if (!PROVIDER_IDS.includes(id)) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  const body = parseBody(providerSettingsSchema, req.body, res);
  if (!body) return;
  const settings = await getProviderSettings();
  const current = settings[id] ?? { enabled: true };
  settings[id] = {
    enabled: body.enabled ?? current.enabled,
    baseUrl: body.baseUrl === null ? undefined : body.baseUrl ?? current.baseUrl,
  };
  await saveProviderSettings(settings);
  await logEvent("info", "admin_action", `Updated provider settings for ${id}`, {
    userId: req.session!.sub,
    provider: id,
  });
  res.json({ provider: { id, ...settings[id] } });
}));

/**
 * POST /api/admin/providers/:id/test — connectivity check using the calling
 * admin's own credentials for that provider.
 */
adminRouter.post("/providers/:id/test", asyncHandler(async (req, res) => {
  const id = req.params.id as ProviderId;
  if (!PROVIDER_IDS.includes(id)) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  const cfg = await db.debridConfig.findUnique({ where: { userId: req.session!.sub } });
  if (!cfg) {
    res.status(400).json({ error: "Configure your own debrid keys first to run tests" });
    return;
  }
  try {
    const creds = await debridManager.credentialsFor(cfg, id);
    const info = await getProvider(id).getUserInfo(creds);
    res.json({ ok: true, account: info });
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message });
  }
}));

/* --------------------------- health & logs ------------------------- */

adminRouter.get("/health", asyncHandler(async (_req, res) => {
  let dbStatus = "up";
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "down";
  }
  const [userCount, titleCount, stats, providerSettings, serverSettings] =
    await Promise.all([
      db.user.count(),
      db.title.count(),
      playbackStats(),
      getProviderSettings(),
      getServerSettings(),
    ]);
  res.json({
    db: dbStatus,
    users: userCount,
    titles: titleCount,
    playback: stats,
    counters: snapshotCounters(),
    providers: PROVIDER_IDS.map((id) => ({
      id,
      enabled:
        providerSettings[id]?.enabled !== false &&
        !serverSettings.disabledProviders.includes(id),
    })),
  });
}));

const LOG_LEVELS = new Set(["info", "warn", "error"]);
const LOG_TYPE = /^[a-z_]{1,40}$/;
function logFilters(query: Request["query"]): Prisma.LogEventWhereInput {
  const where: Prisma.LogEventWhereInput = {};
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const type = text(query.type, 40), level = text(query.level, 10), provider = text(query.provider, 40), userId = text(query.userId, 100), q = text(query.q, 200);
  if (type) where.type = LOG_TYPE.test(type) ? type : "\u0000no-such-type";
  if (level) where.level = LOG_LEVELS.has(level) ? level : "\u0000no-such-level";
  if (provider) where.provider = provider;
  if (userId) where.userId = userId;
  if (q) where.message = { contains: q };
  const range: Prisma.DateTimeFilter = {};
  for (const [key, field] of [["from", "gte"], ["to", "lte"]] as const) {
    const raw = text(query[key], 40);
    if (!raw) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new BadLogRequest(`Invalid ${key} date.`);
    range[field] = date;
  }
  if (range.gte || range.lte) where.createdAt = range;
  return where;
}
class BadLogRequest extends Error {}
const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(JSON.stringify([row.createdAt.getTime(), row.id])).toString("base64url");
function decodeCursor(raw: unknown): Prisma.LogEventWhereInput | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Number.isFinite(at) || typeof id !== "string" || id.length > 100) throw new Error();
    const date = new Date(at);
    return { OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: id } }] };
  } catch { throw new BadLogRequest("Invalid page cursor."); }
}
async function logPage(where: Prisma.LogEventWhereInput, cursor: Prisma.LogEventWhereInput | null, take: number) {
  const rows = await db.logEvent.findMany({ where: cursor ? { AND: [where, cursor] } : where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1 });
  const page = rows.slice(0, take);
  return { page, nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null };
}
adminRouter.get("/logs", asyncHandler(async (req, res) => {
  try {
    const take = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 1000);
    const { page, nextCursor } = await logPage(logFilters(req.query), decodeCursor(req.query.cursor), take);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ logs: page, nextCursor });
  } catch (error) { if (error instanceof BadLogRequest) { res.status(400).json({ error: error.message }); return; } throw error; }
}));
const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  // A leading = + - @ or control character would run as a formula in spreadsheet software.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const EXPORT_FORMATS = { ndjson: { ext: "ndjson", type: "application/x-ndjson" }, csv: { ext: "csv", type: "text/csv" }, txt: { ext: "log", type: "text/plain" } } as const;
adminRouter.get("/logs/export", rateLimit({ windowMs: 60_000, max: 10 }), asyncHandler(async (req, res) => {
  const format = String(req.query.format ?? "ndjson") as keyof typeof EXPORT_FORMATS;
  if (!Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, format)) { res.status(400).json({ error: "Choose ndjson, csv or txt." }); return; }
  let where: Prisma.LogEventWhereInput;
  try { where = logFilters(req.query); } catch (error) { if (error instanceof BadLogRequest) { res.status(400).json({ error: error.message }); return; } throw error; }
  const cap = Math.min(Math.max(parseInt(String(req.query.max ?? "10000"), 10) || 10000, 1), 50000);
  const meta = (value: string | null) => { if (!value) return null; try { return JSON.parse(value); } catch { return value; } };
  res.setHeader("Content-Type", `${EXPORT_FORMATS[format].type}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename="streamrd-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.${EXPORT_FORMATS[format].ext}"`);
  res.setHeader("Cache-Control", "private, no-store");
  if (format === "csv") res.write("time,level,type,provider,userId,message,meta\r\n");
  let sent = 0, cursor: Prisma.LogEventWhereInput | null = null;
  while (sent < cap) {
    const { page, nextCursor } = await logPage(where, cursor, Math.min(1000, cap - sent));
    for (const row of page) {
      const when = row.createdAt.toISOString(), details = meta(row.meta);
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

/* --------------------------- export/import ------------------------- */

adminRouter.get("/export/config", asyncHandler(async (_req, res) => {
  const [server, providerSettings, titles] = await Promise.all([
    getServerSettings(),
    getProviderSettings(),
    db.title.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  res.setHeader("Content-Disposition", "attachment; filename=streamrd-config.json");
  res.json({
    exportedAt: new Date().toISOString(),
    version: 1,
    server,
    providers: providerSettings,
    catalog: titles.map((t) => publicTitle(t, { includeSources: true })),
  });
}));

const importSchema = z.object({
  version: z.literal(1),
  server: serverSettingsSchema.partial().optional(),
  providers: z
    .record(z.object({ enabled: z.boolean(), baseUrl: z.string().optional() }))
    .optional(),
  catalog: z.array(titleSchema.extend({ id: z.string().optional() })).optional(),
});

adminRouter.post("/import/config", asyncHandler(async (req, res) => {
  const body = parseBody(importSchema, req.body, res);
  if (!body) return;
  if (body.server) {
    const current = await getServerSettings();
    await saveServerSettings({ ...current, ...body.server });
  }
  if (body.providers) {
    const current = await getProviderSettings();
    for (const [id, cfg] of Object.entries(body.providers)) {
      if (PROVIDER_IDS.includes(id as ProviderId)) current[id] = cfg;
    }
    await saveProviderSettings(current);
  }
  let imported = 0;
  if (body.catalog) {
    for (const entry of body.catalog) {
      const { id, ...rest } = entry;
      const data = titleData(rest);
      if (id) {
        await db.title.upsert({ where: { id }, create: { id, ...data }, update: data });
      } else {
        await db.title.create({ data });
      }
      imported++;
    }
  }
  await logEvent("info", "admin_action", `Imported configuration (${imported} titles)`, {
    userId: req.session!.sub,
  });
  res.json({ ok: true, importedTitles: imported });
}));
