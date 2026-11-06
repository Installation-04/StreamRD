import { asyncHandler } from "../http";
import { clearIndexerSearchCache } from "../indexers/searchCache";
import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { db } from "../db";
import { logEvent } from "../logger";
import { downloadStats, snapshotCounters } from "../metrics";
import { searchIndexer } from "../indexers/torznab";
import { debridManager } from "../providers/manager";
import { getProvider, providers } from "../providers/registry";
import { PROVIDER_IDS, ProviderId } from "../providers/types";
import { getProviderSettings, getServerSettings, saveProviderSettings, saveServerSettings } from "../settings";
import { parseBody, publicUser } from "./helpers";

export const adminRouter = Router();
// Every /api/admin/* route requires an authenticated admin.
adminRouter.use(requireAuth, requireAdmin);

/* ------------------------------ users ------------------------------ */

adminRouter.get("/users", asyncHandler(async (_req, res) => {
  const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });
  res.json({ users: users.map(publicUser) });
}));

const userUpdateSchema = z.object({
  role: z.enum(["user", "admin"]).optional(),
  active: z.boolean().optional(),
  displayName: z.string().min(1).max(80).optional(),
});

adminRouter.patch("/users/:id", asyncHandler(async (req, res) => {
  const body = parseBody(userUpdateSchema, req.body, res);
  if (!body) return;
  if (req.params.id === req.session!.sub && (body.role === "user" || body.active === false)) {
    res.status(400).json({ error: "You cannot demote or deactivate your own account" });
    return;
  }
  const existing = await db.user.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const user = await db.user.update({ where: { id: req.params.id }, data: { ...body, ...(body.active === false ? { sessionVersion: { increment: 1 } } : {}) } });
  await logEvent("info", "admin_action", `Updated user ${user.email}`, { userId: req.session!.sub, meta: body });
  res.json({ user: publicUser(user) });
}));

/* ----------------------------- indexers ----------------------------- */

adminRouter.get("/indexers", asyncHandler(async (_req, res) => {
  const indexers = await db.indexerConfig.findMany({ orderBy: { createdAt: "asc" } });
  res.json({
    indexers: indexers.map((i) => ({ ...i, apiKey: i.apiKey ? `****${i.apiKey.slice(-4)}` : null })),
  });
}));

const indexerSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  enabled: z.boolean().default(true),
});

adminRouter.post("/indexers", asyncHandler(async (req, res) => {
  const body = parseBody(indexerSchema, req.body, res);
  if (!body) return;
  const indexer = await db.indexerConfig.create({ data: body });
  clearIndexerSearchCache();
  await logEvent("info", "admin_action", `Added indexer "${indexer.name}"`, { userId: req.session!.sub });
  res.status(201).json({ indexer: { ...indexer, apiKey: `****${indexer.apiKey.slice(-4)}` } });
}));

adminRouter.patch("/indexers/:id", asyncHandler(async (req, res) => {
  const body = parseBody(indexerSchema.partial(), req.body, res);
  if (!body) return;
  const existing = await db.indexerConfig.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "Indexer not found" });
    return;
  }
  const indexer = await db.indexerConfig.update({ where: { id: req.params.id }, data: body });
  clearIndexerSearchCache();
  res.json({ indexer: { ...indexer, apiKey: `****${indexer.apiKey.slice(-4)}` } });
}));

adminRouter.delete("/indexers/:id", asyncHandler(async (req, res) => {
  const existing = await db.indexerConfig.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "Indexer not found" });
    return;
  }
  await db.indexerConfig.delete({ where: { id: req.params.id } });
  clearIndexerSearchCache();
  await logEvent("info", "admin_action", `Removed indexer "${existing.name}"`, { userId: req.session!.sub });
  res.json({ ok: true });
}));

/** POST /api/admin/indexers/:id/test — connectivity check with a throwaway query. */
adminRouter.post("/indexers/:id/test", asyncHandler(async (req, res) => {
  const indexer = await db.indexerConfig.findUnique({ where: { id: req.params.id } });
  if (!indexer) {
    res.status(404).json({ error: "Indexer not found" });
    return;
  }
  try {
    const results = await searchIndexer(indexer, "test", { timeoutMs: 10000, limit: 5 });
    res.json({ ok: true, sampleResultCount: results.length });
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message });
  }
}));

/* -------------------------- server settings ------------------------ */

adminRouter.get("/server", asyncHandler(async (_req, res) => {
  res.json({ settings: await getServerSettings() });
}));

const serverSettingsSchema = z.object({
  providerOrder: z.array(z.enum(PROVIDER_IDS)),
  disabledProviders: z.array(z.enum(PROVIDER_IDS)),
  providerTimeoutMs: z.number().int().min(1000).max(120000),
  maxResolveAttempts: z.number().int().min(1).max(10),
  maxResultsPerIndexer: z.number().int().min(1).max(500),
});

adminRouter.put("/server", asyncHandler(async (req, res) => {
  const current = await getServerSettings();
  const body = parseBody(serverSettingsSchema.partial(), req.body, res);
  if (!body) return;
  const merged = { ...current, ...body };
  await saveServerSettings(merged);
  await logEvent("info", "admin_action", "Updated server settings", { userId: req.session!.sub, meta: body });
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
  settings[id] = { enabled: body.enabled ?? current.enabled, baseUrl: body.baseUrl === null ? undefined : body.baseUrl ?? current.baseUrl };
  await saveProviderSettings(settings);
  res.json({ provider: { id, ...settings[id] } });
}));

/** POST /api/admin/providers/:id/test — connectivity check using the calling admin's own credentials. */
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
  const [userCount, indexerCount, stats, providerSettings, serverSettings] = await Promise.all([
    db.user.count(),
    db.indexerConfig.count({ where: { enabled: true } }),
    downloadStats(),
    getProviderSettings(),
    getServerSettings(),
  ]);
  res.json({
    db: dbStatus,
    users: userCount,
    enabledIndexers: indexerCount,
    downloads: stats,
    counters: snapshotCounters(),
    providers: PROVIDER_IDS.map((id) => ({
      id,
      enabled: providerSettings[id]?.enabled !== false && !serverSettings.disabledProviders.includes(id),
    })),
  });
}));

adminRouter.get("/logs", asyncHandler(async (req, res) => {
  const take = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  const where: Record<string, string> = {};
  if (req.query.type) where.type = String(req.query.type);
  if (req.query.provider) where.provider = String(req.query.provider);
  if (req.query.level) where.level = String(req.query.level);
  const logs = await db.logEvent.findMany({ where, orderBy: { createdAt: "desc" }, take });
  res.json({ logs });
}));

/* --------------------------- export/import ------------------------- */

adminRouter.get("/export/config", asyncHandler(async (_req, res) => {
  const [server, providerSettings, indexers] = await Promise.all([
    getServerSettings(),
    getProviderSettings(),
    db.indexerConfig.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  res.setHeader("Content-Disposition", "attachment; filename=phosphor-config.json");
  res.json({
    exportedAt: new Date().toISOString(),
    version: 1,
    server,
    providers: providerSettings,
    indexers,
  });
}));

const importSchema = z.object({
  version: z.literal(1),
  server: serverSettingsSchema.partial().optional(),
  providers: z.record(z.object({ enabled: z.boolean(), baseUrl: z.string().optional() })).optional(),
  indexers: z.array(indexerSchema.extend({ id: z.string().optional() })).optional(),
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
  if (body.indexers) {
    for (const entry of body.indexers) {
      const { id, ...rest } = entry;
      if (id) await db.indexerConfig.upsert({ where: { id }, create: { id, ...rest }, update: rest });
      else await db.indexerConfig.create({ data: rest });
      imported++;
    }
  }
  clearIndexerSearchCache();
  await logEvent("info", "admin_action", `Imported configuration (${imported} indexers)`, { userId: req.session!.sub });
  res.json({ ok: true, importedIndexers: imported });
}));
