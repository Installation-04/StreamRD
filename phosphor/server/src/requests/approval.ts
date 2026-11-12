import { MediaRequest } from "@prisma/client";
import { db } from "../db";
import { logEvent } from "../logger";
import { PROVIDER_IDS, ProviderId } from "../providers/types";
import { runtime } from "../runtime-settings";
import { validateMagnet } from "./clients";
import { qbitContext } from "./config";
import { findBest } from "./finder";
import { lockRequests, RequestDb, RequestError } from "./media";
import { cloudContext } from "./worker";

/**
 * Approving a request: the administrator does it from Admin → Requests, and, unless the server is set otherwise (Admin → Server), the server
 * does it by itself when a request arrives: it looks for the best release, and sends it to the first administrator who has a cloud download
 * account and a library to publish into. Where it cannot, the request waits for a person, with the reason in its history.
 */
export interface Approval {
  requestId: string; actorId: string; destination: "cloud" | "local"; providerId: ProviderId | null; sourceUrl: string;
  sharedLibraryId?: string | null; chosen?: string; automatic?: boolean;
  /** Checked inside the transaction, before anything is changed (the route verifies the signed-in administrator here). */
  check?: (tx: RequestDb) => Promise<unknown>;
}
export async function approveRequest(input: Approval): Promise<MediaRequest> {
  const { requestId, actorId, destination, providerId, sourceUrl } = input;
  validateMagnet(sourceUrl);
  if (destination === "local" && providerId) throw new RequestError("Local downloads use qBittorrent rather than a debrid provider");
  const context = destination === "cloud" ? await cloudContext(actorId, providerId ?? "") : await qbitContext(actorId);
  return db.$transaction(async tx => {
    await lockRequests(tx); await input.check?.(tx);
    const existing = await tx.mediaRequest.findUnique({ where: { id: requestId } });
    if (!existing) throw new RequestError("Media request not found", 404);
    const approvalBlocked = existing.status === "attention" && existing.downloadState === "approval_blocked" && !existing.startedAt && !existing.providerRef;
    if ((!approvalBlocked && !["requested", "rejected", "cancelled"].includes(existing.status)) || existing.startedAt || existing.providerRef) throw new RequestError("This request has already entered download processing", 409);
    if (input.sharedLibraryId) {
      const library = await tx.sharedLibrary.findFirst({ where: { id: input.sharedLibraryId, sourceUserId: actorId, enabled: true } });
      if (!library || !["all", existing.mediaType].includes(library.mediaType)) throw new RequestError("Choose one of your enabled libraries with a matching media type", 400);
    }
    const where = destination === "cloud" ? "cloud" : "local qBittorrent";
    const by = input.automatic ? "Approved automatically" : "Administrator approved";
    return tx.mediaRequest.update({ where: { id: requestId }, data: { status: "approved", destination, sourceUserId: actorId,
      sharedLibraryId: input.sharedLibraryId ?? null, sourceUrl, providerId: providerId ?? null, sourceFingerprint: context.fingerprint,
      providerRef: null, progress: null, downloadState: null, error: null, attempts: 0, leaseUntil: null, nextPollAt: new Date(), revision: { increment: 1 },
      events: { create: { status: "approved", message: input.chosen ? `${by}; the best release was chosen automatically (${input.chosen}) for ${where} download.` : `${by} a selected release for ${where} download.` } } } });
  }, { maxWait: 10000, timeout: 10000 });
}

/** Who the server approves as, and where the download goes: the first active administrator with a working cloud connection and an enabled library for this kind of title. */
async function automaticTarget(mediaType: string): Promise<{ actorId: string; providerId: ProviderId; sharedLibraryId: string } | { reason: string }> {
  const admins = await db.user.findMany({ where: { role: "admin", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const none = "no administrator has a working cloud download account (Setup → Real-Debrid or another provider)";
  let reason = none;
  for (const admin of admins) {
    const config = await db.debridConfig.findUnique({ where: { userId: admin.id }, select: { primaryProvider: true } });
    if (!config || !PROVIDER_IDS.includes(config.primaryProvider as ProviderId)) continue;
    const providerId = config.primaryProvider as ProviderId;
    try { await cloudContext(admin.id, providerId); } catch { reason = none; continue; }
    const library = await db.sharedLibrary.findFirst({ where: { sourceUserId: admin.id, enabled: true, mediaType }, orderBy: { createdAt: "asc" } })
      ?? await db.sharedLibrary.findFirst({ where: { sourceUserId: admin.id, enabled: true, mediaType: "all" }, orderBy: { createdAt: "asc" } });
    if (!library) { reason = "there is no enabled shared library to put it in (Admin → Libraries)"; continue; }
    return { actorId: admin.id, providerId, sharedLibraryId: library.id };
  }
  return { reason };
}
/** Adds a line to the request's history unless the newest line already says the same, so a retry does not repeat itself. */
async function note(requestId: string, message: string) {
  const last = await db.requestEvent.findFirst({ where: { requestId }, orderBy: { createdAt: "desc" }, select: { message: true } });
  if (last?.message === message) return;
  await db.requestEvent.create({ data: { requestId, status: "requested", message } });
}
/** Approves a waiting request by itself. Never throws: a request it cannot approve stays as it was, with the reason in its history and in the log. */
export async function approveAutomatically(requestId: string): Promise<{ approved: boolean; reason?: string }> {
  try {
    if (!runtime().requestsAutoApprove) return { approved: false, reason: "automatic approval is off" };
    const request = await db.mediaRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== "requested") return { approved: false, reason: "the request is not waiting" };
    const target = await automaticTarget(request.mediaType);
    if ("reason" in target) { await note(request.id, `Waiting for an administrator: it could not be approved automatically because ${target.reason}.`); return { approved: false, reason: target.reason }; }
    let best;
    try { best = await findBest({ name: request.name, year: request.year, type: request.mediaType === "series" ? "series" : "movie" }); }
    catch (error) { const why = error instanceof Error ? error.message : "no release was found"; await note(request.id, `Waiting for an administrator: ${why}`.slice(0, 300)); return { approved: false, reason: why }; }
    await approveRequest({ requestId, actorId: target.actorId, destination: "cloud", providerId: target.providerId, sharedLibraryId: target.sharedLibraryId, sourceUrl: best.magnet, chosen: best.title.slice(0, 160), automatic: true });
    void logEvent("info", "system", `Approved the request for ${request.name} automatically`, { meta: { requestId } }).catch(() => undefined);
    return { approved: true };
  } catch (error) {
    const why = error instanceof Error ? error.message : "unknown error";
    void logEvent("warn", "system", `Automatic approval of a request failed: ${why}`.slice(0, 300), { meta: { requestId } }).catch(() => undefined);
    return { approved: false, reason: why };
  }
}

/** Requests that could not be approved when they arrived (no indexer yet, a release not out yet) are tried again now and then. */
export async function retryAutomaticApprovals(limit = 5): Promise<number> {
  if (!runtime().requestsAutoApprove) return 0;
  const waiting = await db.mediaRequest.findMany({ where: { status: "requested", updatedAt: { lt: new Date(Date.now() - 15 * 60_000), gt: new Date(Date.now() - 14 * 86_400_000) } }, orderBy: { updatedAt: "asc" }, take: limit, select: { id: true } });
  let approved = 0;
  for (const { id } of waiting) {
    if ((await approveAutomatically(id)).approved) approved += 1;
    else await db.mediaRequest.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => undefined);   // go to the back of the line
  }
  return approved;
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startAutomaticApprovals(everyMs = 15 * 60_000): void {
  if (timer) return;
  timer = setInterval(() => { void retryAutomaticApprovals().catch(() => undefined); }, everyMs); timer.unref();
}
