import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Router, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { asyncHandler } from "../http";
import { logEvent } from "../logger";
import { AccountLibraryError, playImportedMedia } from "../account-library";
import { assertActiveSharedViewer, assertSharedViewer, assertUnchangedSharedViewer, sharedLibraryView, sharedMediaWhere, visibleSharedLibrary, visibleSharedLibraryWhere } from "../shared-libraries";
import { accountMediaViews } from "./account-library";
import { rateLimit } from "../util/rateLimit";
import { viewingLimit } from "../restrictions";
import { versionViews } from "../versions";
import { favoriteIds, favoriteItems, MAX_FAVORITES, setFavorite } from "../favorites";
import { setWatched, unwatchedWhere, watchedIds } from "../watched";
import { planPlayback, registerStream } from "../transcode";
import { trailerFor } from "../home";
import { attentionCounts, attentionWhere } from "../attention";
import { ageForRating, syncAccountRating } from "../ratings";

export const sharedLibrariesRouter = Router();
export const adminSharedLibrariesRouter = Router();
const noStore = (_req: Request, res: Response, next: () => void) => { res.setHeader("Cache-Control", "private, no-store"); next(); };
sharedLibrariesRouter.use(noStore, requireAuth);
adminSharedLibrariesRouter.use(noStore, requireAuth, requireAdmin);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const mediaType = z.enum(["all", "movie", "series"]);
const fields = z.object({ name: z.string().trim().min(1).max(80), mediaType: mediaType.default("all"), everyone: z.boolean().default(false) }).strict();
const list = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(512).optional(), q: z.string().trim().max(200).optional(), type: z.enum(["movie", "series"]).optional(), unwatched: z.enum(["1"]).optional(), attention: z.enum(["1"]).optional() }).strict();
const cursorSchema = z.object({ v: z.literal(1), id, at: z.string().datetime(), scope: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
function action(run: (req: Request, res: Response) => Promise<unknown>) {
  return asyncHandler(async (req, res) => {
    try { await run(req, res); }
    catch (error) { if (error instanceof AccountLibraryError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
  });
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, message = "Invalid library request."): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AccountLibraryError(message);
  return parsed.data;
}
async function ownedLibrary(req: Request) {
  if (!id.safeParse(req.params.id).success) throw new AccountLibraryError("Shared library not found.", 404);
  const library = await db.sharedLibrary.findFirst({ where: { id: req.params.id, sourceUserId: req.session!.sub } });
  if (!library) throw new AccountLibraryError("Shared library not found.", 404);
  return library;
}
/** Withhold a stale page if account bindings or item eligibility changed while decorating it. */
async function assertCurrentSharedItems(library: Awaited<ReturnType<typeof visibleSharedLibrary>>, originalWhere: Prisma.AccountMediaWhereInput, itemIds: string[], limit: number | null) {
  const freshWhere = await sharedMediaWhere(library, limit);
  if (JSON.stringify(freshWhere) !== JSON.stringify(originalWhere)) throw new AccountLibraryError("Shared library account changed. Refresh and try again.", 409);
  if (itemIds.length && await db.accountMedia.count({ where: { id: { in: itemIds }, AND: [freshWhere] } }) !== itemIds.length) throw new AccountLibraryError("Shared library items changed. Refresh and try again.", 409);
}
async function adminView(library: Awaited<ReturnType<typeof ownedLibrary>>) {
  const grants = await db.sharedLibraryGrant.findMany({ where: { libraryId: library.id }, orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, email: true, displayName: true, active: true } } } });
  return { ...await sharedLibraryView(library), enabled: library.enabled, everyone: library.everyone, createdAt: library.createdAt.toISOString(), updatedAt: library.updatedAt.toISOString(), users: grants.map(grant => grant.user) };
}
async function audit(req: Request, message: string, libraryId: string, userId?: string) {
  await logEvent("info", "admin_action", message, { userId: req.session!.sub, meta: { libraryId, ...(userId ? { targetUserId: userId } : {}) } });
}
adminSharedLibrariesRouter.get("/", action(async (req, res) => {
  const libraries = await db.sharedLibrary.findMany({ where: { sourceUserId: req.session!.sub }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
  res.json({ libraries: await Promise.all(libraries.map(adminView)) });
}));
adminSharedLibrariesRouter.post("/", action(async (req, res) => {
  const body = parse(fields, req.body);
  const library = await db.$transaction(async tx => {
    // Serialize the per-owner limit across concurrent requests/processes.
    await tx.setting.upsert({ where: { key: "shared-libraries.create.lock" }, create: { key: "shared-libraries.create.lock", value: "1" }, update: { value: "1" } });
    if (await tx.sharedLibrary.count({ where: { sourceUserId: req.session!.sub } }) >= 100) throw new AccountLibraryError("You can create at most 100 shared libraries.", 409);
    return tx.sharedLibrary.create({ data: { ...body, sourceUserId: req.session!.sub } });
  });
  await audit(req, "Created a shared library", library.id);
  res.status(201).json({ library: await adminView(library) });
}));
adminSharedLibrariesRouter.patch("/:id", action(async (req, res) => {
  const library = await ownedLibrary(req);
  const body = parse(z.object({ name: fields.shape.name.optional(), mediaType: mediaType.optional(), enabled: z.boolean().optional(), everyone: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0), req.body);
  const updated = await db.sharedLibrary.update({ where: { id: library.id }, data: body });
  await audit(req, "Updated a shared library", library.id);
  res.json({ library: await adminView(updated) });
}));
adminSharedLibrariesRouter.delete("/:id", action(async (req, res) => {
  const library = await ownedLibrary(req);
  await db.sharedLibrary.delete({ where: { id: library.id } });
  await audit(req, "Removed a shared library", library.id);
  res.json({ ok: true });
}));
/** An administrator sets (or clears) the age rating of one of their imported titles; it wins over the metadata rating. */
adminSharedLibrariesRouter.put("/items/:itemId/rating", action(async (req, res) => {
  const itemId = parse(id, req.params.itemId), body = parse(z.object({ rating: z.string().trim().min(1).max(20).nullable() }).strict(), req.body, "Choose a rating such as G, PG, PG-13, R, TV-Y7, TV-PG, TV-14 or TV-MA, or clear it.");
  if (body.rating !== null && ageForRating(body.rating) === null) throw new AccountLibraryError("Choose a known rating such as G, PG, PG-13, R, TV-Y7, TV-PG, TV-14 or TV-MA.");
  const item = await db.accountMedia.findFirst({ where: { id: itemId, userId: req.session!.sub }, select: { id: true } });
  if (!item) throw new AccountLibraryError("Library item not found.", 404);
  await db.accountMedia.update({ where: { id: itemId }, data: { ratingOverride: body.rating } });
  const rating = await syncAccountRating(itemId);
  await logEvent("info", "admin_action", body.rating === null ? "Cleared a title's age rating override" : "Set a title's age rating", { userId: req.session!.sub, meta: { itemId } });
  res.json({ ...rating, ratingManual: body.rating !== null });
}));
adminSharedLibrariesRouter.post("/:id/users", action(async (req, res) => {
  const library = await ownedLibrary(req), body = parse(z.object({ userId: id }).strict(), req.body);
  const user = await db.user.findUnique({ where: { id: body.userId }, select: { id: true } });
  if (!user) throw new AccountLibraryError("User not found.", 404);
  if (user.id === library.sourceUserId) throw new AccountLibraryError("The source owner already has access.");
  await db.sharedLibraryGrant.upsert({ where: { libraryId_userId: { libraryId: library.id, userId: user.id } }, create: { libraryId: library.id, userId: user.id }, update: {} });
  await audit(req, "Granted shared library access", library.id, user.id);
  res.json({ ok: true });
}));
adminSharedLibrariesRouter.delete("/:id/users/:userId", action(async (req, res) => {
  const library = await ownedLibrary(req);
  const userId = parse(id, req.params.userId);
  await db.sharedLibraryGrant.deleteMany({ where: { libraryId: library.id, userId } });
  await audit(req, "Revoked shared library access", library.id, userId);
  res.json({ ok: true });
}));
sharedLibrariesRouter.get("/", action(async (req, res) => {
  const libraries = await db.sharedLibrary.findMany({ where: visibleSharedLibraryWhere(req.session!.sub), orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
  const ageLimit = await viewingLimit(req.session!.sub), views = await Promise.all(libraries.map(library => sharedLibraryView(library, ageLimit)));
  await assertActiveSharedViewer(req.session!);
  const fresh = await db.sharedLibrary.findMany({ where: { ...visibleSharedLibraryWhere(req.session!.sub), id: { in: libraries.map(library => library.id) } }, select: { id: true, updatedAt: true } });
  const unchanged = new Set(fresh.filter(library => libraries.some(original => original.id === library.id && original.updatedAt.getTime() === library.updatedAt.getTime())).map(library => library.id));
  res.json({ libraries: views.filter(library => unchanged.has(library.id)) });
}));
sharedLibrariesRouter.get("/continue", action(async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(20).default(12) }).strict(), req.query);
  const userId = req.session!.sub, ageLimit = await viewingLimit(userId);
  const libraries = await db.sharedLibrary.findMany({ where: visibleSharedLibraryWhere(userId), orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
  const rows = libraries.length ? await db.sharedLibraryProgress.findMany({ where: { userId, completed: false, positionSeconds: { gt: 0 } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 200 }) : [];
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.itemId)) latest.set(row.itemId, row);
  const pending = new Map(latest), items: Array<{ progress: (typeof rows)[number]; libraryId: string; media: Awaited<ReturnType<typeof accountMediaViews>>[number] }> = [];
  for (const library of libraries) {
    if (!pending.size) break;
    const found = await db.accountMedia.findMany({ where: { id: { in: [...pending.keys()] }, AND: [await sharedMediaWhere(library, ageLimit)] } });
    const views = await accountMediaViews(found);
    found.forEach((media, index) => { items.push({ progress: pending.get(media.id)!, libraryId: library.id, media: views[index] }); pending.delete(media.id); });
  }
  await assertActiveSharedViewer(req.session!);
  items.sort((a, b) => b.progress.updatedAt.getTime() - a.progress.updatedAt.getTime() || (a.progress.id < b.progress.id ? 1 : -1));
  res.json({ items: items.slice(0, limit).map(({ progress, libraryId, media }) => ({ libraryId, item: media, positionSeconds: progress.positionSeconds, durationSeconds: progress.durationSeconds, updatedAt: progress.updatedAt.toISOString() })) });
}));
/** My List: the viewer's own list of titles, newest first. */
sharedLibrariesRouter.get("/favorites", action(async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(100) }).strict(), req.query);
  const ageLimit = await viewingLimit(req.session!.sub), rows = await favoriteItems(req.session!.sub, ageLimit, limit);
  const views = await accountMediaViews(rows.map(row => row.item));
  await assertActiveSharedViewer(req.session!);
  const seen = await watchedIds(req.session!.sub, rows.map(row => row.item));
  res.json({ items: rows.map((row, index) => ({ libraryId: row.libraryId, item: { ...views[index], favorite: true, watched: seen.has(row.item.id) } })) });
}));
for (const method of ["put", "delete"] as const) {
  sharedLibrariesRouter[method]("/:id/items/:itemId/favorite", rateLimit({ windowMs: 60_000, max: 120 }), action(async (req, res) => {
    const library = await visibleSharedLibrary(req.session!.sub, parse(id, req.params.id));
    const ageLimit = await viewingLimit(req.session!.sub), sourceWhere = await sharedMediaWhere(library, ageLimit);
    const item = await db.accountMedia.findFirst({ where: { id: parse(id, req.params.itemId), AND: [sourceWhere] } });
    if (!item) throw new AccountLibraryError("Library item not found.", 404);
    await assertUnchangedSharedViewer(req.session!, library);
    const result = await setFavorite(req.session!.sub, item, method === "put");
    if (result === "full") throw new AccountLibraryError(`Your list is full (${MAX_FAVORITES} titles). Remove one first.`, 409);
    if (result === "ungrouped") throw new AccountLibraryError("This title is still being prepared. Try again in a moment.", 409);
    res.json({ favorite: result });
  }));
}
for (const method of ["put", "delete"] as const) {
  sharedLibrariesRouter[method]("/:id/items/:itemId/watched", rateLimit({ windowMs: 60_000, max: 120 }), action(async (req, res) => {
    const library = await visibleSharedLibrary(req.session!.sub, parse(id, req.params.id));
    const item = await db.accountMedia.findFirst({ where: { id: parse(id, req.params.itemId), AND: [await sharedMediaWhere(library, await viewingLimit(req.session!.sub))] } });
    if (!item) throw new AccountLibraryError("Library item not found.", 404);
    await assertUnchangedSharedViewer(req.session!, library);
    const result = await setWatched(req.session!.sub, item, method === "put");
    if (result === "ungrouped") throw new AccountLibraryError("This title is still being prepared. Try again in a moment.", 409);
    res.json({ watched: result });
  }));
}
sharedLibrariesRouter.get("/:id/items", action(async (req, res) => {
  const library = await visibleSharedLibrary(req.session!.sub, parse(id, req.params.id));
  const { limit, cursor, q, type, unwatched, attention } = parse(list, req.query), admin = req.session!.role === "admin";
  const ageLimit = await viewingLimit(req.session!.sub), sourceWhere = await sharedMediaWhere(library, ageLimit);
  const filters: Prisma.AccountMediaWhereInput = { AND: [sourceWhere, { isPrimary: true }, ...(q ? [{ name: { contains: q } }] : []), ...(type ? [{ type }] : []), ...(unwatched ? [await unwatchedWhere(req.session!.sub) ?? {}] : []), ...(attention && admin ? [await attentionWhere(library.sourceUserId)] : [])] };
  const scope = createHash("sha256").update(JSON.stringify([req.session!.sub, library.id, library.updatedAt.toISOString(), filters])).digest("hex").slice(0, 32);
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try { const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); if (Buffer.from(JSON.stringify(value)).toString("base64url") !== cursor || value.scope !== scope) throw Error(); after = value; }
    catch { throw new AccountLibraryError("This page cursor does not belong to the current shared library search."); }
  }
  const where: Prisma.AccountMediaWhereInput = after ? { AND: [filters, { OR: [{ createdAt: { lt: new Date(after.at) } }, { createdAt: new Date(after.at), id: { lt: after.id } }] }] } : filters;
  const [items, total] = await Promise.all([db.accountMedia.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 }), db.accountMedia.count({ where: filters })]);
  const page = items.slice(0, limit), last = page.at(-1), listed = await favoriteIds(req.session!.sub, page), seen = await watchedIds(req.session!.sub, page), views = (await accountMediaViews(page)).map((view, index) => ({ ...view, favorite: listed.has(page[index].id), watched: seen.has(page[index].id) }));
  await assertUnchangedSharedViewer(req.session!, library);
  await assertCurrentSharedItems(library, sourceWhere, page.map(item => item.id), ageLimit);
  const needs = admin ? await attentionCounts(sourceWhere, library.sourceUserId) : undefined;
  res.json({ items: views, total, ...(needs ? { attention: needs } : {}), nextCursor: items.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, id: last.id, at: last.createdAt.toISOString(), scope })).toString("base64url") : null });
}));
/** The title's trailer, when the public catalogue has one (a YouTube id the viewer's browser plays only after pressing Watch trailer). */
sharedLibrariesRouter.get("/:id/items/:itemId/trailer", action(async (req, res) => {
  const library = await visibleSharedLibrary(req.session!.sub, parse(id, req.params.id));
  const item = await db.accountMedia.findFirst({ where: { id: parse(id, req.params.itemId), AND: [await sharedMediaWhere(library, await viewingLimit(req.session!.sub))] } });
  if (!item) throw new AccountLibraryError("Library item not found.", 404);
  const [view] = await accountMediaViews([item]);
  res.json({ trailer: await trailerFor(view.metadata?.imdbId, item.type === "series" ? "series" : "movie") });
}));
sharedLibrariesRouter.get("/:id/items/:itemId", action(async (req, res) => {
  const library = await visibleSharedLibrary(req.session!.sub, parse(id, req.params.id));
  const ageLimit = await viewingLimit(req.session!.sub), sourceWhere = await sharedMediaWhere(library, ageLimit);
  const item = await db.accountMedia.findFirst({ where: { id: parse(id, req.params.itemId), AND: [sourceWhere] } });
  if (!item) throw new AccountLibraryError("Library item not found.", 404);
  const result = { item: { ...(await accountMediaViews([item]))[0], favorite: (await favoriteIds(req.session!.sub, [item])).has(item.id), watched: (await watchedIds(req.session!.sub, [item])).has(item.id) }, library: await sharedLibraryView(library, ageLimit), versions: await versionViews(sourceWhere, item) };
  await assertUnchangedSharedViewer(req.session!, library);
  await assertCurrentSharedItems(library, sourceWhere, [item.id], ageLimit);
  res.json(result);
}));
sharedLibrariesRouter.post("/:id/items/:itemId/play", rateLimit({ windowMs: 60_000, max: 60 }), action(async (req, res) => {
  const libraryId = parse(id, req.params.id), itemId = parse(id, req.params.itemId);
  const body = parse(z.object({ fileToken: z.string().min(1).max(512).optional() }).strict(), req.body ?? {});
  const library = await assertSharedViewer(req.session!, libraryId);
  const authorize = async () => {
    const freshLibrary = await assertSharedViewer(req.session!, libraryId);
    const item = await db.accountMedia.findFirst({ where: { id: itemId, AND: [await sharedMediaWhere(freshLibrary, await viewingLimit(req.session!.sub))] }, select: { id: true } });
    if (!item || freshLibrary.sourceUserId !== library.sourceUserId) throw new AccountLibraryError("Library item not found.", 404);
  };
  const { mediaKey, ...result } = await playImportedMedia(library.sourceUserId, itemId, body.fileToken, authorize);
  await authorize();
  if (!result.stream || !mediaKey) { res.json(result); return; }
  // Resume state belongs to the viewer; each play supersedes older player sessions.
  const userId = req.session!.sub, progressSessionId = randomUUID();
  const saved = await db.sharedLibraryProgress.upsert({
    where: { userId_itemId_mediaKey: { userId, itemId, mediaKey } },
    create: { userId, itemId, mediaKey, activeSessionId: progressSessionId },
    update: { activeSessionId: progressSessionId, lastSequence: -1 },
  });
  // A browser cannot play every file. When this one needs converting the viewer gets a stream id of ours instead of the provider link for the <video>.
  const plan = await planPlayback(result.stream.url, result.stream.filename).catch(() => ({ mode: "direct" as const, probe: null, reason: "error" }));
  const playback = plan.mode === "direct" ? { mode: "direct" as const, reason: plan.reason, durationSeconds: plan.probe?.durationSeconds ?? 0, video: plan.probe?.video ?? null, audio: plan.probe?.audio ?? null }
    : { mode: plan.mode, url: `/api/stream/${registerStream(result.stream.url, plan.mode, userId)}`, durationSeconds: plan.probe?.durationSeconds ?? 0, video: plan.probe?.video ?? null, audio: plan.probe?.audio ?? null };
  res.json({ ...result, progressSessionId, resumeSeconds: saved.completed ? 0 : saved.positionSeconds, durationSeconds: saved.durationSeconds || playback.durationSeconds, playback });
}));
const progressBody = z.object({
  sessionId: z.string().min(1).max(200), sequence: z.number().int().min(0).max(2147483647),
  positionSeconds: z.number().finite().min(0).max(604800), durationSeconds: z.number().finite().positive().max(604800),
}).strict().refine(body => body.positionSeconds <= body.durationSeconds + 1);
sharedLibrariesRouter.put("/:id/items/:itemId/progress", rateLimit({ windowMs: 60_000, max: 240 }), action(async (req, res) => {
  const libraryId = parse(id, req.params.id), itemId = parse(id, req.params.itemId), body = parse(progressBody, req.body, "Invalid playback progress.");
  const library = await assertSharedViewer(req.session!, libraryId);
  const item = await db.accountMedia.findFirst({ where: { id: itemId, AND: [await sharedMediaWhere(library, await viewingLimit(req.session!.sub))] }, select: { id: true } });
  if (!item) throw new AccountLibraryError("Library item not found.", 404);
  const positionSeconds = Math.min(body.positionSeconds, body.durationSeconds);
  const updated = await db.sharedLibraryProgress.updateMany({
    where: { userId: req.session!.sub, itemId, activeSessionId: body.sessionId, lastSequence: { lt: body.sequence } },
    data: { positionSeconds, durationSeconds: body.durationSeconds, completed: positionSeconds >= body.durationSeconds * 0.95, lastSequence: body.sequence, updatedAt: new Date() },
  });
  if (updated.count) { res.json({ accepted: true }); return; }
  const known = await db.sharedLibraryProgress.findFirst({ where: { userId: req.session!.sub, itemId, activeSessionId: body.sessionId }, select: { id: true } });
  if (!known) throw new AccountLibraryError("Playback session not found or superseded.", 404);
  res.json({ accepted: false, reason: "out-of-order" });
}));
