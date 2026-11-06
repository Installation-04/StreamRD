import { asyncHandler } from "../http";
import { Router } from "express";
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
import { parseBody, publicTitle, publicUser } from "./helpers";

export const adminRouter = Router();
// Every /api/admin/* route requires an authenticated admin. RBAC tests
// assert both the 401 (no session) and 403 (non-admin) paths.
adminRouter.use(requireAuth, requireAdmin);

/* ------------------------------ users ------------------------------ */

adminRouter.get("/users", asyncHandler(async (_req, res) => {
  const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });
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
  const existing = await db.user.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const user = await db.user.update({ where: { id: req.params.id }, data: { ...body, ...(body.active === false ? { sessionVersion: { increment: 1 } } : {}) } });
  await logEvent("info", "admin_action", `Updated user ${user.email}`, {
    userId: req.session!.sub,
    meta: body,
  });
  res.json({ user: publicUser(user) });
}));

/* ----------------------------- catalog ----------------------------- */

adminRouter.get("/catalog", asyncHandler(async (_req, res) => {
  const titles = await db.title.findMany({ orderBy: { createdAt: "desc" } });
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
  const body = parseBody(titleSchema, req.body, res);
  if (!body) return;
  const title = await db.title.create({ data: titleData(body) });
  await logEvent("info", "admin_action", `Created title "${title.name}"`, {
    userId: req.session!.sub,
  });
  res.status(201).json({ title: publicTitle(title, { includeSources: true }) });
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
  const title = await db.title.update({ where: { id: req.params.id }, data });
  res.json({ title: publicTitle(title, { includeSources: true }) });
}));

adminRouter.delete("/catalog/:id/delete", asyncHandler(async (req, res) => {
  const existing = await db.title.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "Title not found" });
    return;
  }
  await db.title.delete({ where: { id: req.params.id } });
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

adminRouter.get("/logs", asyncHandler(async (req, res) => {
  const take = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  const where: Record<string, string> = {};
  if (req.query.type) where.type = String(req.query.type);
  if (req.query.provider) where.provider = String(req.query.provider);
  if (req.query.userId) where.userId = String(req.query.userId);
  if (req.query.level) where.level = String(req.query.level);
  const logs = await db.logEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
  });
  res.json({ logs });
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
