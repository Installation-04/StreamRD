import { createHash } from "node:crypto";
import { AccountMedia, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { asyncHandler } from "../http";
import { AccountLibraryError, cancelAccountScan, getAccountScanStatus, playImportedMedia, queueAccountScans } from "../account-library";
import { PROVIDER_IDS } from "../providers/types";
import { decorateAccountMedia } from "../metadata/account";

export const accountLibraryRouter = Router();
accountLibraryRouter.use(requireAuth);
accountLibraryRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(512).optional(), q: z.string().trim().max(200).optional(), type: z.enum(["movie", "series"]).optional() });
const cursorSchema = z.object({ v: z.literal(1), id: idSchema, at: z.string().datetime(), scope: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
function action(run: (req: import("express").Request, res: import("express").Response) => Promise<unknown>) {
  return asyncHandler(async (req, res) => {
    try { await run(req, res); }
    catch (error) { if (error instanceof AccountLibraryError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
  });
}
/** Whitelist a private media view; internal refs, owner IDs and credential bindings never leave this module. */
export async function accountMediaViews(items: AccountMedia[]) {
  const decorated = await decorateAccountMedia(items);
  return decorated.map(item => ({ id: item.id, name: item.name, type: item.type, year: item.year, provider: item.provider, phase: item.phase, progress: item.progress, createdAt: item.createdAt.toISOString(), metadata: item.metadata, metadataStatus: item.metadataStatus }));
}
accountLibraryRouter.get("/", action(async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) throw new AccountLibraryError("Invalid library search, type, cursor or page size.");
  const { limit, cursor, q, type } = parsed.data, userId = req.session!.sub;
  const scope = createHash("sha256").update(JSON.stringify([userId, q ?? "", type ?? ""])).digest("hex").slice(0, 32);
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try { const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); if (Buffer.from(JSON.stringify(value)).toString("base64url") !== cursor || value.scope !== scope) throw new Error(); after = value; }
    catch { throw new AccountLibraryError("This page cursor does not belong to the current library search."); }
  }
  const filters: Prisma.AccountMediaWhereInput = { userId, ...(q ? { name: { contains: q } } : {}), ...(type ? { type } : {}) };
  const where: Prisma.AccountMediaWhereInput = after ? { AND: [filters, { OR: [{ createdAt: { lt: new Date(after.at) } }, { createdAt: new Date(after.at), id: { lt: after.id } }] }] } : filters;
  const [items, total] = await Promise.all([db.accountMedia.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 }), db.accountMedia.count({ where: filters })]);
  const page = items.slice(0, limit), last = page.at(-1);
  res.json({ items: await accountMediaViews(page), total, nextCursor: items.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, id: last.id, at: last.createdAt.toISOString(), scope })).toString("base64url") : null });
}));
accountLibraryRouter.get("/scans", action(async (req, res) => { res.json(await getAccountScanStatus(req.session!.sub)); }));
accountLibraryRouter.post("/scan", action(async (req, res) => {
  const parsed = z.object({ provider: z.enum(PROVIDER_IDS).optional(), force: z.boolean().default(false) }).strict().safeParse(req.body ?? {});
  if (!parsed.success) throw new AccountLibraryError("Choose a supported provider and a valid rescan option.");
  const { provider, force } = parsed.data;
  res.json(await queueAccountScans(req.session!.sub, { provider, force, automatic: !force }));
}));
accountLibraryRouter.post("/scan/cancel", action(async (req, res) => {
  const parsed = z.object({ provider: z.enum(PROVIDER_IDS) }).strict().safeParse(req.body);
  if (!parsed.success) throw new AccountLibraryError("Choose a supported provider to cancel.");
  await cancelAccountScan(req.session!.sub, parsed.data.provider); res.json({ ok: true });
}));
accountLibraryRouter.get("/:id", action(async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) throw new AccountLibraryError("Library item not found.", 404);
  const item = await db.accountMedia.findFirst({ where: { id: req.params.id, userId: req.session!.sub } });
  if (!item) throw new AccountLibraryError("Library item not found.", 404);
  res.json({ item: (await accountMediaViews([item]))[0] });
}));
accountLibraryRouter.post("/:id/play", action(async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) throw new AccountLibraryError("Library item not found.", 404);
  const parsed = z.object({ fileToken: z.string().min(1).max(512).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) throw new AccountLibraryError("Choose a valid video file.");
  res.json(await playImportedMedia(req.session!.sub, req.params.id, parsed.data.fileToken));
}));
accountLibraryRouter.delete("/:id", action(async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) throw new AccountLibraryError("Library item not found.", 404);
  await db.$transaction(async tx => {
    const item = await tx.accountMedia.findFirst({ where: { id: req.params.id, userId: req.session!.sub } });
    if (!item) throw new AccountLibraryError("Library item not found.", 404);
    await tx.metadataRecord.deleteMany({ where: { targetType: "account", targetId: item.id, ownerId: req.session!.sub } });
    await tx.accountMedia.delete({ where: { id: item.id } });
  });
  res.json({ ok: true });
}));
