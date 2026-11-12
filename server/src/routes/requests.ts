import { logEvent } from "../logger";
import { Prisma } from "@prisma/client";
import { Request, Response, Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { db } from "../db";
import { asyncHandler } from "../http";
import { searchMetadata, fetchMetadata } from "../metadata/providers";
import { MetadataError } from "../metadata/types";
import { PROVIDER_IDS } from "../providers/types";
import { assertRequestActor, canonicalMediaKey, lockRequests, mediaAvailability, requestAvailability, requestEvents, requestView, RequestError, REQUEST_STATUSES, ACTIVE_REQUEST_STATUSES } from "../requests/media";
import { RequestClientError, validateMagnet } from "../requests/clients";
import { addIndexer, FinderError, findBest, findReleases, listIndexers, publicIndexer, removeIndexer, testIndexer } from "../requests/finder";
import { resumeRequestPolling } from "../requests/worker";
import { approveAutomatically, approveRequest } from "../requests/approval";
import { rateLimit } from "../util/rateLimit";
import { runtime } from "../runtime-settings";

export const discoveryRouter = Router(), requestsRouter = Router(), adminRequestsRouter = Router();
const noStore = (_req: Request, res: Response, next: () => void) => { res.setHeader("Cache-Control", "private, no-store"); next(); };
for (const router of [discoveryRouter, requestsRouter, adminRequestsRouter]) router.use(noStore, requireAuth);
adminRequestsRouter.use(requireAdmin);
const lookupLimit = rateLimit({ windowMs: 60_000, max: 60 });
const mutationLimit = rateLimit({ windowMs: 60_000, max: 30 });
const identity = z.object({ provider: z.enum(["tmdb", "omdb", "free"]), id: z.string().min(1).max(40), type: z.enum(["movie", "series"]) }).strict();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
function action(run: (req: Request, res: Response) => Promise<unknown>) {
  return asyncHandler(async (req, res) => {
    try { await run(req, res); }
    catch (error) {
      if (error instanceof RequestError || error instanceof MetadataError || error instanceof RequestClientError || error instanceof FinderError) { res.status(error.status).json({ error: error.message }); return; }
      throw error;
    }
  });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError("Invalid request fields");
  return result.data;
}
async function followed(req: Request, admin = false) {
  const requestId = parse(id, req.params.id);
  const request = await db.mediaRequest.findFirst({ where: { id: requestId, ...(admin ? {} : { followers: { some: { userId: req.session!.sub } } }) } });
  if (!request) throw new RequestError("Media request not found", 404);
  return request;
}
const pageInput = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: id.optional(), status: z.enum(REQUEST_STATUSES).optional(), q: z.string().trim().max(200).optional() }).strict();

discoveryRouter.get("/search", lookupLimit, action(async (req, res) => {
  const query = parse(z.object({ q: z.string().trim().min(1).max(200), type: z.enum(["movie", "series"]), provider: z.enum(["tmdb", "omdb", "free"]).optional() }).strict(), req.query);
  const results = await searchMetadata({ query: query.q, type: query.type, provider: query.provider });
  await assertRequestActor(req.session!);
  res.json({ results });
}));
discoveryRouter.get("/:provider/:type/:id", lookupLimit, action(async (req, res) => {
  const selection = parse(identity, req.params), media = await fetchMetadata(selection);
  const [availability, existing] = await Promise.all([mediaAvailability(req.session!.sub, media), db.mediaRequest.findUnique({ where: { canonicalKey: canonicalMediaKey(media) } })]);
  const published = existing ? await requestAvailability(existing, req.session!.sub) : [];
  const view = existing ? await requestView(existing, req.session!.sub) : null;
  await assertRequestActor(req.session!);
  res.json({ media, availability: [...availability, ...published].filter((entry, index, list) => list.findIndex(other => other.href === entry.href) === index), request: view });
}));

requestsRouter.post("/", mutationLimit, action(async (req, res) => {
  const selection = parse(identity, req.body), media = await fetchMetadata(selection);
  const availability = await mediaAvailability(req.session!.sub, media);
  if (availability.length) { await assertRequestActor(req.session!); res.status(409).json({ error: "This title is already in your available library", availability }); return; }
  const result = await db.$transaction(async tx => {
    await lockRequests(tx); await assertRequestActor(req.session!, tx);
    const canonicalKey = canonicalMediaKey(media), existing = await tx.mediaRequest.findUnique({ where: { canonicalKey } });
    const alreadyFollowing = existing && await tx.requestFollower.findUnique({ where: { requestId_userId: { requestId: existing.id, userId: req.session!.sub } } });
    if (!alreadyFollowing) {
      if (await tx.requestFollower.count({ where: { userId: req.session!.sub, request: { status: { in: ACTIVE_REQUEST_STATUSES } } } }) >= 20) throw new RequestError("You can track at most 20 active requests", 409);
    }
    if (!existing && await tx.mediaRequest.count({ where: { status: { in: ACTIVE_REQUEST_STATUSES } } }) >= 2000) throw new RequestError("The server request queue is full", 409);
    const request = existing ?? await tx.mediaRequest.create({ data: { canonicalKey, provider: media.provider, externalId: media.id, mediaType: media.type,
      name: media.name, year: media.year, metadata: JSON.stringify(media), events: { create: { status: "requested", message: runtime().requestsAutoApprove ? "Request received. The server is looking for a release." : "Request received. Waiting for administrator approval." } } } });
    await tx.requestFollower.upsert({ where: { requestId_userId: { requestId: request.id, userId: req.session!.sub } }, create: { requestId: request.id, userId: req.session!.sub }, update: {} });
    if (existing && !alreadyFollowing && existing.status === "available") {
      await tx.mediaRequest.update({ where: { id: request.id }, data: { updatedAt: new Date(), events: { create: { status: "available", message: "Another member is tracking this title; library access may be needed." } } } });
    }
    return { request, created: !existing };
  }, { maxWait: 10000, timeout: 10000 });
  if (result.created) void approveAutomatically(result.request.id);   // unless the server is set to wait for an administrator (Admin → Server)
  res.status(result.created ? 201 : 200).json({ request: await requestView(result.request, req.session!.sub) });
}));
requestsRouter.get("/", action(async (req, res) => {
  const parsed = pageInput.safeParse(req.query); if (!parsed.success) throw new RequestError("Invalid request list query");
  const { limit, cursor, status, q } = parsed.data;
  const where: Prisma.MediaRequestWhereInput = { followers: { some: { userId: req.session!.sub } }, ...(status ? { status } : {}), ...(q ? { name: { contains: q } } : {}) };
  if (cursor && !await db.mediaRequest.findFirst({ where: { id: cursor, ...where }, select: { id: true } })) throw new RequestError("Invalid request page cursor");
  const rows = await db.mediaRequest.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  res.json({ requests: await Promise.all(rows.slice(0, limit).map(row => requestView(row, req.session!.sub))), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
}));
requestsRouter.get("/:id", action(async (req, res) => {
  const request = await followed(req, req.session!.role === "admin"), view = await requestView(request, req.session!.sub);
  res.json({ request: view, events: await requestEvents(request.id, request.status === "available" && view.status !== "available") });
}));
requestsRouter.post("/:id/unfollow", mutationLimit, action(async (req, res) => {
  const requestId = parse(id, req.params.id);
  await db.requestFollower.deleteMany({ where: { requestId, userId: req.session!.sub } });
  res.json({ ok: true });
}));

adminRequestsRouter.get("/", action(async (req, res) => {
  const parsed = pageInput.safeParse(req.query); if (!parsed.success) throw new RequestError("Invalid request list query");
  const { limit, cursor, status, q } = parsed.data;
  const where: Prisma.MediaRequestWhereInput = { ...(status ? { status } : {}), ...(q ? { name: { contains: q } } : {}) };
  if (cursor && !await db.mediaRequest.findFirst({ where: { id: cursor, ...where }, select: { id: true } })) throw new RequestError("Invalid request page cursor");
  const rows = await db.mediaRequest.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  res.json({ requests: await Promise.all(rows.slice(0, limit).map(row => requestView(row, req.session!.sub, true))), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
}));
adminRequestsRouter.get("/:id", action(async (req, res) => {
  const request = await followed(req, true);
  res.json({ request: await requestView(request, req.session!.sub, true), events: await requestEvents(request.id) });
}));
/** Releases found for a request, best first, so the administrator can see what "automatic" would pick and choose another. */
adminRequestsRouter.get("/:id/releases", rateLimit({ windowMs: 60_000, max: 20 }), action(async (req, res) => {
  const wanted = await db.mediaRequest.findUnique({ where: { id: parse(id, req.params.id) }, select: { name: true, year: true, mediaType: true } });
  if (!wanted) throw new RequestError("Media request not found", 404);
  const found = await findReleases({ name: wanted.name, year: wanted.year, type: wanted.mediaType === "series" ? "series" : "movie" });
  res.json({ indexers: found.indexers, errors: found.errors.slice(0, 5), candidates: found.candidates.slice(0, 15).map(({ title, magnet, sizeBytes, seeders, source, tags, score, pack }) => ({ title: title.slice(0, 200), magnet, sizeBytes, seeders, source, tags, score, pack })) });
}));
adminRequestsRouter.post("/:id/approve", mutationLimit, action(async (req, res) => {
  const body = parse(z.object({ destination: z.enum(["cloud", "local"]), sourceUrl: z.string().trim().min(1).max(8192).optional(), providerId: z.enum(PROVIDER_IDS).optional(), sharedLibraryId: id.optional() }).strict(), req.body);
  const requestId = parse(id, req.params.id);
  // No magnet given: find the best release by itself (Admin → Requests lists the indexers it searches).
  let sourceUrl = body.sourceUrl, chosen = "";
  if (!sourceUrl) {
    const wanted = await db.mediaRequest.findUnique({ where: { id: requestId }, select: { name: true, year: true, mediaType: true } });
    if (!wanted) throw new RequestError("Media request not found", 404);
    const best = await findBest({ name: wanted.name, year: wanted.year, type: wanted.mediaType === "series" ? "series" : "movie" });
    sourceUrl = best.magnet; chosen = best.title.slice(0, 160);
  }
  validateMagnet(sourceUrl);
  let providerId = body.providerId;
  if (body.destination === "cloud" && !providerId) {
    const cfg = await db.debridConfig.findUnique({ where: { userId: req.session!.sub }, select: { primaryProvider: true } });
    if (!cfg || !PROVIDER_IDS.includes(cfg.primaryProvider as typeof PROVIDER_IDS[number])) throw new RequestError("Configure a cloud provider before approving", 409);
    providerId = cfg.primaryProvider as typeof PROVIDER_IDS[number];
  }
  const request = await approveRequest({ requestId, actorId: req.session!.sub, destination: body.destination, providerId: providerId ?? null, sourceUrl, sharedLibraryId: body.sharedLibraryId, chosen,
    check: tx => assertRequestActor(req.session!, tx, true) });
  res.json({ request: await requestView(request, req.session!.sub, true) });
}));
for (const status of ["rejected", "cancelled"] as const) adminRequestsRouter.post(`/:id/${status === "rejected" ? "reject" : "cancel"}`, mutationLimit, action(async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().max(300).optional() }).strict(), req.body ?? {}), requestId = parse(id, req.params.id);
  const request = await db.$transaction(async tx => {
    await lockRequests(tx); await assertRequestActor(req.session!, tx, true);
    const existing = await tx.mediaRequest.findUnique({ where: { id: requestId } });
    if (!existing) throw new RequestError("Media request not found", 404);
    const approvalBlocked = existing.status === "attention" && existing.downloadState === "approval_blocked" && !existing.startedAt && !existing.providerRef;
    if ((!approvalBlocked && !["requested", "approved"].includes(existing.status)) || existing.startedAt || existing.providerRef) throw new RequestError("This download may have started. Stop tracking does not cancel provider content.", 409);
    if (existing.sourceUserId && existing.sourceUserId !== req.session!.sub) throw new RequestError("Only the approving administrator can change this queued download", 403);
    return tx.mediaRequest.update({ where: { id: requestId }, data: { status, leaseUntil: null, revision: { increment: 1 }, events: { create: { status,
      message: body.reason || (status === "rejected" ? "An administrator declined this request." : "An administrator cancelled this request before download submission.") } } } });
  }, { maxWait: 10000, timeout: 10000 });
  res.json({ request: await requestView(request, req.session!.sub, true) });
}));

adminRequestsRouter.post("/:id/resume", mutationLimit, action(async (req, res) => {
  const body = parse(z.object({ reference: z.string().trim().min(1).max(200).optional() }).strict(), req.body ?? {});
  await assertRequestActor(req.session!, db, true);
  const row = await resumeRequestPolling(parse(id, req.params.id), req.session!.sub, body.reference, tx => assertRequestActor(req.session!, tx, true).then(() => {}));
  res.json({ request: await requestView(row, req.session!.sub, true) });
}));

/** Admin → Requests: the Torznab indexers the automatic release search uses. */
export const requestIndexersRouter = Router();
requestIndexersRouter.use(noStore, requireAuth, requireAdmin);
requestIndexersRouter.get("/", action(async (_req, res) => { res.json({ indexers: (await listIndexers()).map(publicIndexer) }); }));
requestIndexersRouter.post("/", mutationLimit, action(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().max(80).default("Indexer"), baseUrl: z.string().trim().min(1).max(2048), apiKey: z.string().trim().max(1500).default("") }).strict(), req.body);
  const entry = await addIndexer({ name: body.name ?? "Indexer", baseUrl: body.baseUrl, apiKey: body.apiKey ?? "" }), test = await testIndexer(entry);
  void logEvent(test.ok ? "info" : "warn", "admin_action", `Added the indexer ${entry.name}: ${test.message}`, { userId: req.session!.sub, meta: { indexerId: entry.id, results: test.results } }).catch(() => undefined);
  res.status(201).json({ indexer: publicIndexer(entry), test });
}));
requestIndexersRouter.post("/:id/test", mutationLimit, action(async (req, res) => {
  const found = (await listIndexers()).find(entry => entry.id === req.params.id);
  if (!found) throw new FinderError("Indexer not found.", 404);
  res.json(await testIndexer(found));
}));
requestIndexersRouter.delete("/:id", mutationLimit, action(async (req, res) => {
  if (req.params.id === "zilean") throw new FinderError("Zilean comes from the installer (ZILEAN_URL). Run install.sh --no-zilean to remove it.", 409);
  if (!await removeIndexer(parse(id, req.params.id))) throw new FinderError("Indexer not found.", 404);
  void logEvent("info", "admin_action", "Removed an indexer", { userId: req.session!.sub, meta: { indexerId: req.params.id } }).catch(() => undefined);
  res.json({ ok: true });
}));
