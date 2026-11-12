import { AccessError } from "../auth/access";
import { accessRouter } from "./access";
import { getMetadataSettings, providerConfigured } from "../metadata/settings";
import { asyncHandler } from "../http";
import { Prisma } from "@prisma/client";
import { Request, Router } from "express";
import { rateLimit } from "../util/rateLimit";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { db } from "../db";
import { logEvent } from "../logger";
import { logsRouter } from "./logs";
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
import { parseBody, publicUser } from "./helpers";

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
  const [userCount, titleCount, brokenLinks, stats, providerSettings, serverSettings] =
    await Promise.all([
      db.user.count(),
      db.accountMedia.count({ where: { isPrimary: true, user: { role: "admin" } } }), // library titles (the retired catalogue is not counted)
      db.accountMedia.count({ where: { phase: "finished", health: "broken", user: { role: "admin" } } }),
      playbackStats(),
      getProviderSettings(),
      getServerSettings(),
    ]);
  res.json({
    db: dbStatus,
    users: userCount,
    titles: titleCount,
    brokenLinks,
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

// Admin → Logs: search, export and the diagnostic bundle (see routes/logs.ts).
adminRouter.use("/logs", logsRouter);

/* --------------------------- export/import ------------------------- */

adminRouter.get("/export/config", asyncHandler(async (_req, res) => {
  const [server, providerSettings] = await Promise.all([getServerSettings(), getProviderSettings()]);
  res.setHeader("Content-Disposition", "attachment; filename=streamrd-config.json");
  res.json({
    exportedAt: new Date().toISOString(),
    version: 1,
    server,
    providers: providerSettings,
  });
}));

const importSchema = z.object({
  version: z.literal(1),
  server: serverSettingsSchema.partial().optional(),
  providers: z
    .record(z.object({ enabled: z.boolean(), baseUrl: z.string().optional() }))
    .optional(),
  catalog: z.unknown().optional(), // accepted from older exports and ignored: the curated catalogue was retired in v0.18.0
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
  await logEvent("info", "admin_action", "Imported configuration", {
    userId: req.session!.sub,
  });
  res.json({ ok: true });
}));
