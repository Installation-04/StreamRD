import { Prisma } from "@prisma/client";
import { accountProviderContext } from "./account-library";
import { db } from "./db";
import { logEvent } from "./logger";
import { storedMetadata } from "./metadata/automation";
import { playAccountItem } from "./providers/account-library";
import { PROVIDER_IDS, ProviderError, ProviderId } from "./providers/types";
import { ACTIVE_REQUEST_STATUSES, canonicalMediaKey, lockRequests } from "./requests/media";
import { LinkResult, recordLinkResult } from "./link-state";

const HOUR = 3_600_000;
/** How long a result is trusted before the item is checked again. */
export const RECHECK = { ok: 24 * HOUR, unknown: HOUR, broken: 6 * HOUR };

/** Does the resolved link still answer? Only a definite "not found" counts against it; everything else is inconclusive. */
export async function probeLink(url: string): Promise<LinkResult> {
  let target: URL;
  try { target = new URL(url); } catch { return { state: "transient" }; }
  if (target.protocol !== "https:") return { state: "ok" }; // the provider resolved it; there is nothing to fetch
  const attempt = (method: string, headers: Record<string, string> = {}) => fetch(target, { method, headers, redirect: "follow", signal: AbortSignal.timeout(10_000) });
  try {
    let response = await attempt("HEAD");
    if ([403, 405, 501].includes(response.status)) response = await attempt("GET", { Range: "bytes=0-0" });
    if (response.status === 404 || response.status === 410) return { state: "gone", message: `The link answers ${response.status}` };
    return response.status < 400 ? { state: "ok" } : { state: "transient" };
  } catch { return { state: "transient" }; }
}

/** Checks one finished import with the provider and records the result. */
export async function checkItem(itemId: string): Promise<"skipped" | "ok" | "unknown" | "broken"> {
  const item = await db.accountMedia.findUnique({ where: { id: itemId } });
  if (!item || item.phase !== "finished" || !PROVIDER_IDS.includes(item.provider as ProviderId)) return "skipped";
  const provider = item.provider as ProviderId, ctx = await accountProviderContext(item.userId, provider);
  if (!ctx.active || !ctx.configured || !ctx.enabled || ctx.fingerprint !== item.credentialFingerprint) {
    await db.accountMedia.update({ where: { id: item.id }, data: { healthCheckedAt: new Date() } }); // not checkable now; look again later
    return "skipped";
  }
  let result: LinkResult;
  try {
    const play = await playAccountItem(provider, ctx.creds, item.providerRef);
    if (play.stream) result = await probeLink(play.stream.url);
    else if (play.selectionRequired) result = { state: "ok" }; // the provider lists its files
    else result = { state: "transient" }; // still downloading
  } catch (error) {
    const status = error instanceof ProviderError ? error.statusCode : undefined;
    result = status === 404 || status === 410 || status === 422 ? { state: "gone", message: "The provider no longer serves this item" } : { state: "transient" };
  }
  const recorded = await recordLinkResult(item.id, result);
  if (recorded.health === "broken") await ensureReplacement(item.id);
  return recorded.health === "broken" ? "broken" : result.state === "ok" ? "ok" : "unknown";
}

/**
 * A title whose only working copy is gone gets a replacement request (waiting for the administrator's approval, like any request),
 * unless another version of it works, a request for it is already on its way, or an administrator rejected or cancelled one.
 */
export async function ensureReplacement(itemId: string): Promise<"switched" | "requested" | "none"> {
  const item = await db.accountMedia.findUnique({ where: { id: itemId } });
  if (!item || !item.groupKey) return "none";
  const working = await db.accountMedia.count({ where: { userId: item.userId, groupKey: item.groupKey, id: { not: item.id }, health: { not: "broken" }, phase: "finished" } });
  if (working) return "switched";
  const record = await db.metadataRecord.findFirst({ where: { targetType: "account", targetId: item.id, ownerId: item.userId, status: "matched" } });
  const media = record ? storedMetadata(record.data) : null;
  if (!media) return "none"; // no confirmed identity to request by; the administrator is told through the log and the library
  const canonicalKey = canonicalMediaKey(media), message = "The link for this title stopped working. A replacement was requested and is waiting for administrator approval.";
  return db.$transaction(async tx => {
    await lockRequests(tx);
    const existing = await tx.mediaRequest.findUnique({ where: { canonicalKey } });
    if (existing && ACTIVE_REQUEST_STATUSES.includes(existing.status)) return "requested" as const;
    if (existing && !["available", "downloaded", "failed"].includes(existing.status)) return "none" as const; // rejected or cancelled by an administrator: not reopened
    let id: string;
    if (!existing) {
      id = (await tx.mediaRequest.create({ data: { canonicalKey, provider: media.provider, externalId: media.id, mediaType: media.type, name: media.name, year: media.year, metadata: JSON.stringify(media), events: { create: { status: "requested", message } } } })).id;
    } else {
      id = existing.id;
      await tx.mediaRequest.update({ where: { id }, data: { status: "requested", destination: null, sourceUserId: null, sharedLibraryId: null, sourceUrl: null, providerId: null, providerRef: null, sourceFingerprint: null, progress: null, downloadState: null, error: null, revision: { increment: 1 }, attempts: 0, leaseUntil: null, nextPollAt: new Date(), startedAt: null, downloadedAt: null, availableAt: null, events: { create: { status: "requested", message } } } });
    }
    await tx.requestFollower.upsert({ where: { requestId_userId: { requestId: id, userId: item.userId } }, create: { requestId: id, userId: item.userId }, update: {} });
    void logEvent("warn", "system", `Replacement requested for ${media.name}`, { userId: item.userId, meta: { itemId: item.id, requestId: id } });
    return "requested" as const;
  }, { maxWait: 10000, timeout: 10000 });
}

/** Finished imports of active administrators whose last result is old enough to look at again, oldest first. */
export async function dueItems(limit: number) {
  const now = Date.now(), older = (ms: number) => ({ lt: new Date(now - ms) });
  const where: Prisma.AccountMediaWhereInput = { phase: "finished", user: { role: "admin", active: true }, OR: [
    { healthCheckedAt: null }, { health: "ok", healthCheckedAt: older(RECHECK.ok) }, { health: "unknown", healthCheckedAt: older(RECHECK.unknown) }, { health: "broken", healthCheckedAt: older(RECHECK.broken) },
  ] };
  return db.accountMedia.findMany({ where, orderBy: [{ healthCheckedAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } });
}

export async function runLinkHealthJob(limit = Number(process.env.LINK_HEALTH_BATCH) || 3): Promise<number> {
  const items = await dueItems(Math.max(1, Math.min(limit, 20)));
  for (const item of items) { try { await checkItem(item.id); } catch { /* one bad item never stops the rest */ } }
  return items.length;
}

export async function linkHealthSummary() {
  const rows = await db.accountMedia.groupBy({ by: ["health"], where: { phase: "finished", user: { role: "admin" } }, _count: { _all: true } });
  const count = (health: string) => rows.find(row => row.health === health)?._count._all ?? 0;
  const broken = await db.accountMedia.findMany({ where: { phase: "finished", health: "broken", user: { role: "admin" } }, orderBy: [{ healthCheckedAt: "desc" }, { id: "asc" }], take: 50, select: { id: true, name: true, year: true, healthError: true, healthCheckedAt: true } });
  return { ok: count("ok"), unknown: count("unknown"), broken: count("broken"), items: broken.map(item => ({ id: item.id, name: item.name, year: item.year, reason: item.healthError, checkedAt: item.healthCheckedAt?.toISOString() ?? null })) };
}

/** Checks a few items a minute in the background (set LINK_HEALTH=false to turn it off). */
export function startLinkHealthWorker() {
  if (process.env.LINK_HEALTH === "false") return;
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await runLinkHealthJob(); } catch { /* retried on the next tick */ } finally { busy = false; } };
  setInterval(() => void tick(), 60_000).unref();
  setTimeout(() => void tick(), 15_000).unref();
}
