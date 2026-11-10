import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { asyncHandler } from "../http";
import { db } from "../db";
import { parseBody } from "./helpers";
import { MetadataError } from "../metadata/types";
import { fetchMetadata, searchMetadata, testMetadataProvider } from "../metadata/providers";
import { getMetadataSettings, metadataSettingsPatchSchema, publicMetadataSettings, saveMetadataSettings } from "../metadata/settings";
import { matchMetadata, metadataView, MetadataOperationError, queueTarget, recordFor, requireTarget, scanMetadata, setMetadataLocks } from "../metadata/automation";
import { LOCK_FIELDS, TargetType, ADMIN_TARGET_TYPES } from "../metadata/targets";

export const metadataRouter = Router();
metadataRouter.use(requireAuth, requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
function action(run: (req: Request, res: Response) => Promise<void>) {
  return asyncHandler(async (req, res) => {
    try { await run(req, res); }
    catch (error) {
      if (error instanceof MetadataError || error instanceof MetadataOperationError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(503).json({ error: "Metadata operation is unavailable. Check the server and provider configuration, then try again." });
    }
  });
}
const provider = z.enum(["tmdb", "omdb", "free"]), type = z.enum(["movie", "series"]);
export const metadataSelectionSchema = z.object({ provider, id: z.string().min(1).max(32), type }).strict().refine(value => value.provider === "tmdb" ? /^[1-9]\d{0,9}$/.test(value.id) : /^tt\d{7,10}$/.test(value.id), { message: "Use a valid provider title ID" });
const searchSchema = z.object({ query: z.string().trim().min(1).max(160), type, year: z.number().int().min(1800).max(2200).optional(), provider: provider.optional() }).strict();
const targetSchema = z.object({ targetType: z.enum(["catalog", "library"]), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
function targetParams(req: Request) { const value = targetSchema.safeParse(req.params); if (!value.success || !ADMIN_TARGET_TYPES.includes(value.data.targetType)) throw new MetadataOperationError("Unknown metadata target", 404); return value.data; }
metadataRouter.get("/settings", action(async (_req, res) => { res.json({ settings: publicMetadataSettings(await getMetadataSettings()) }); }));
metadataRouter.put("/settings", action(async (req, res) => {
  const body = parseBody(metadataSettingsPatchSchema, req.body, res); if (!body) return;
  await saveMetadataSettings(body); res.json({ settings: publicMetadataSettings(await getMetadataSettings()) });
}));
metadataRouter.post("/test", action(async (req, res) => {
  const body = parseBody(z.object({ provider }).strict(), req.body, res); if (!body) return;
  await testMetadataProvider(body.provider); res.json({ ok: true, provider: body.provider });
}));
metadataRouter.post("/search", action(async (req, res) => { const body = parseBody(searchSchema, req.body, res); if (body) res.json({ results: await searchMetadata(body) }); }));
metadataRouter.post("/preview", action(async (req, res) => { const body = parseBody(metadataSelectionSchema, req.body, res); if (body) res.json({ metadata: await fetchMetadata(body) }); }));
metadataRouter.get("/records", action(async (req, res) => {
  const query = z.object({ cursor: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid metadata page size or cursor" }); return; }
  const { cursor, limit } = query.data;
  const [rows, groups] = await Promise.all([
    db.metadataRecord.findMany({ where: { targetType: { in: ADMIN_TARGET_TYPES }, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: limit + 1 }),
    db.metadataRecord.groupBy({ where: { targetType: { in: ADMIN_TARGET_TYPES } }, by: ["status"], _count: { _all: true } }),
  ]);
  const summary = { queued: 0, processing: 0, matched: 0, review: 0, unmatched: 0, error: 0 };
  for (const group of groups) if (Object.prototype.hasOwnProperty.call(summary, group.status)) summary[group.status as keyof typeof summary] = group._count._all;
  res.json({ records: rows.slice(0, limit).map(metadataView), nextCursor: rows.length > limit ? rows[limit - 1].id : null, summary });
}));
metadataRouter.post("/scan", action(async (req, res) => {
  const body = parseBody(z.object({ targetType: z.enum(["catalog", "library"]).optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{0,128}$/).optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(), req.body ?? {}, res);
  if (body) res.json(await scanMetadata(body.targetType ?? ADMIN_TARGET_TYPES[0], body.cursor ?? "", body.limit));
}));
metadataRouter.get("/records/:targetType/:targetId", action(async (req, res) => {
  const { targetType, targetId } = targetParams(req); await requireTarget(targetType, targetId);
  const record = await recordFor(targetType, targetId); res.json({ record: record ? metadataView(record) : null });
}));
metadataRouter.post("/records/:targetType/:targetId/match", action(async (req, res) => {
  const { targetType, targetId } = targetParams(req);
  const body = parseBody(z.object({ provider, id: z.string().min(1).max(32), type, expectedRevision: z.number().int().nonnegative().optional() }).strict(), req.body, res);
  if (!body) return;
  if (!metadataSelectionSchema.safeParse({ provider: body.provider, id: body.id, type: body.type }).success) { res.status(400).json({ error: "Invalid provider title ID" }); return; }
  res.json({ record: metadataView(await matchMetadata(targetType, targetId, body)) });
}));
metadataRouter.post("/records/:targetType/:targetId/refresh", action(async (req, res) => {
  const { targetType, targetId } = targetParams(req);
  const record = await queueTarget(await requireTarget(targetType, targetId), true, true);
  res.json({ record: record ? metadataView(record) : null });
}));
metadataRouter.patch("/records/:targetType/:targetId/locks", action(async (req, res) => {
  const { targetType, targetId } = targetParams(req);
  const body = parseBody(z.object({ lockedFields: z.array(z.enum(LOCK_FIELDS)).max(6), expectedRevision: z.number().int().nonnegative().optional() }).strict(), req.body, res);
  if (body) res.json({ record: metadataView(await setMetadataLocks(targetType, targetId, body.lockedFields, body.expectedRevision)) });
}));
metadataRouter.delete("/records/:targetType/:targetId", action(async (req, res) => {
  const { targetType, targetId } = targetParams(req);
  await db.metadataRecord.deleteMany({ where: { targetType, targetId } }); res.json({ ok: true });
}));
