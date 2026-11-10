import { Router, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../auth/middleware";
import { asyncHandler } from "../http";
import { rateLimit } from "../util/rateLimit";
import { parseBody } from "./helpers";
import { metadataSelectionSchema } from "./metadata";
import { fetchMetadata, searchMetadata } from "../metadata/providers";
import { MetadataError } from "../metadata/types";
import { LOCK_FIELDS } from "../metadata/targets";
import { matchMetadata, metadataView, MetadataOperationError, queueTarget, recordFor, requireTarget, setMetadataLocks } from "../metadata/automation";

/** Personal metadata is owner-bound, including preview/search requests. */
export const accountMetadataRouter = Router({ mergeParams: true });
accountMetadataRouter.use(requireAuth, asyncHandler(async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  const id = req.params.id;
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !(await db.accountMedia.findFirst({ where: { id, userId: req.session!.sub }, select: { id: true } }))) {
    res.status(404).json({ error: "Library item not found" }); return;
  }
  next();
}));
const lookupLimit = rateLimit({ windowMs: 60000, max: 60, message: "Too many metadata requests; wait a moment and try again" });
accountMetadataRouter.use((req, res, next) => req.method === "GET" ? next() : lookupLimit(req, res, next));
function action(run: (req: Request, res: Response) => Promise<void>) {
  return asyncHandler(async (req, res) => {
    try { await run(req, res); }
    catch (error) {
      if (error instanceof MetadataError || error instanceof MetadataOperationError) {
        res.status(error.status).json({ error: error instanceof MetadataError && error.code === "metadata-not-configured" ? "Ask an administrator to configure the metadata provider before matching titles" : error.message }); return;
      }
      res.status(503).json({ error: "Metadata is unavailable. Try again later." });
    }
  });
}
accountMetadataRouter.get("/", action(async (req, res) => {
  const record = await recordFor("account", req.params.id);
  res.json({ record: record && record.ownerId === req.session!.sub ? metadataView(record) : null });
}));
accountMetadataRouter.post("/search", action(async (req, res) => {
  const body = parseBody(z.object({ query: z.string().trim().min(1).max(160), type: z.enum(["movie", "series"]), year: z.number().int().min(1800).max(2200).optional(), provider: z.enum(["tmdb", "omdb", "free"]).optional() }).strict(), req.body, res);
  if (body) res.json({ results: await searchMetadata(body) });
}));
accountMetadataRouter.post("/preview", action(async (req, res) => {
  const body = parseBody(metadataSelectionSchema, req.body, res);
  if (body) res.json({ metadata: await fetchMetadata(body) });
}));
accountMetadataRouter.post("/match", action(async (req, res) => {
  const body = parseBody(z.object({ provider: z.enum(["tmdb", "omdb", "free"]), id: z.string().min(1).max(32), type: z.enum(["movie", "series"]), expectedRevision: z.number().int().nonnegative().optional() }).strict(), req.body, res);
  if (!body) return;
  if (!metadataSelectionSchema.safeParse({ provider: body.provider, id: body.id, type: body.type }).success) { res.status(400).json({ error: "Invalid provider title ID" }); return; }
  res.json({ record: metadataView(await matchMetadata("account", req.params.id, body)) });
}));
accountMetadataRouter.post("/refresh", action(async (req, res) => {
  const record = await queueTarget(await requireTarget("account", req.params.id), true, true);
  res.json({ record: record ? metadataView(record) : null });
}));
accountMetadataRouter.patch("/locks", action(async (req, res) => {
  const body = parseBody(z.object({ lockedFields: z.array(z.enum(LOCK_FIELDS)).max(6), expectedRevision: z.number().int().nonnegative().optional() }).strict(), req.body, res);
  if (body) res.json({ record: metadataView(await setMetadataLocks("account", req.params.id, body.lockedFields, body.expectedRevision)) });
}));
