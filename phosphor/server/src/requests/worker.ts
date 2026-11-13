import { MediaRequest, Prisma } from "@prisma/client";
import { db } from "../db";
import { accountProviderContext, queueAccountScans } from "../account-library";
import { getProvider } from "../providers/registry";
import { PROVIDER_IDS, ProviderError, ProviderId } from "../providers/types";
import { logEvent } from "../logger";
import { QbitClient, RequestClientError, TransferState, validateMagnet } from "./clients";
import { qbitContext } from "./config";

type SourceDb = Pick<Prisma.TransactionClient, "setting" | "user" | "debridConfig">;
export async function cloudContext(userId: string, providerId: string, client: SourceDb = db) {
  if (!PROVIDER_IDS.includes(providerId as ProviderId)) throw new RequestClientError("Choose a supported cloud provider.");
  const provider = providerId as ProviderId;
  const [ctx, actor] = await Promise.all([accountProviderContext(userId, provider, client), client.user.findFirst({ where: { id: userId, active: true, role: "admin" }, select: { id: true } })]);
  if (!actor || !ctx.active || !ctx.configured || !ctx.enabled) throw new RequestClientError("The source administrator or cloud connection is unavailable. Restore its configuration before resuming.");
  return { fingerprint: ctx.fingerprint, creds: ctx.creds, provider };
}
const next = (seconds: number) => new Date(Date.now() + seconds * 1000);
/**
 * When the cloud provider answered a submission with a refusal, why, in words the administrator can act on. Null when it did not answer
 * (a timeout, a server error, no connection): then nobody can tell whether the transfer was created, and it is not submitted again by itself.
 * Real-Debrid names its refusals with a short code; the code is matched here and never shown.
 */
export function refusalOf(error: unknown): string | null {
  if (!(error instanceof ProviderError)) return null;
  let name = "The provider"; try { name = getProvider(error.provider).displayName || name; } catch { /* keep the general name */ }
  const detail = error.message.replace(/^\[[^\]]*\]\s*/, "").toLowerCase(), code = error.statusCode ?? 0;
  if (/infring|blocked|banned/.test(detail)) return `${name} refused this torrent (it blocks some releases).`;
  if (/premium|permission_denied|account_locked|not_allowed.*account/.test(detail)) return `${name} would not accept it: the account needs an active premium subscription.`;
  if (/bad_token|expired_token|invalid_token|auth/.test(detail) || code === 401) return `${name} did not accept the saved key. Save it again in Setup, then approve this request again.`;
  if (/ip_not_allowed|action_not_allowed|ip_address|vpn|proxy/.test(detail) || code === 403) return `${name} refused this server's address (a VPN or data-centre address is often not allowed).`;
  if (/too_many_active|active_downloads|slot|limit/.test(detail) && code !== 429) return `${name} says too many downloads are already active on the account.`;
  if (/too_many_requests/.test(detail) || code === 429) return `${name} is limiting requests from this server. Try again in a few minutes.`;
  if (/magnet|torrent|invalid|bad_request|file/.test(detail) && code >= 400 && code < 500) return `${name} could not read this release's magnet link or its files.`;
  if (code >= 400 && code < 500) return `${name} refused the request (${detail.slice(0, 60) || code}).`;
  return null;
}
const WORKING = ["approved", "submitting", "queued", "downloading", "downloaded"];
async function claim() {
  return db.$transaction(async tx => {
    await tx.setting.upsert({ where: { key: "requests.worker.lock" }, create: { key: "requests.worker.lock", value: "1" }, update: { value: "1" } });
    const job = await tx.mediaRequest.findFirst({ where: { status: { in: WORKING }, nextPollAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, orderBy: [{ nextPollAt: "asc" }, { createdAt: "asc" }] });
    if (!job) return null;
    const claimed = await tx.mediaRequest.update({ where: { id: job.id }, data: { leaseUntil: next(60), revision: { increment: 1 }, ...(job.status === "approved" ? { status: "submitting", startedAt: new Date() } : {}) } });
    return { job: claimed, submit: job.status === "approved" };
  }, { maxWait: 10000, timeout: 10000 });
}
async function finish(job: MediaRequest, data: Prisma.MediaRequestUpdateManyMutationInput, message?: string, guard = false) {
  return db.$transaction(async tx => {
    if (guard) await binding(job, tx);
    if (data.status === "available") {
      const item = await tx.accountMedia.findFirst({ where: { userId: job.sourceUserId!, provider: job.providerId!, providerRef: job.providerRef!, credentialFingerprint: job.sourceFingerprint!, phase: "finished", type: job.mediaType } });
      const library = await tx.sharedLibrary.findFirst({ where: { id: job.sharedLibraryId!, sourceUserId: job.sourceUserId!, enabled: true, OR: [{ mediaType: "all" }, { mediaType: job.mediaType }] } });
      if (!item || !library) throw new RequestClientError("The source import or sharing configuration changed before publication.");
    }
    const changed = await tx.mediaRequest.updateMany({ where: { id: job.id, revision: job.revision }, data: { ...data, leaseUntil: null, revision: { increment: 1 } } });
    if (changed.count && message) await tx.requestEvent.create({ data: { requestId: job.id, status: typeof data.status === "string" ? data.status : job.status, message, progress: typeof data.progress === "number" ? data.progress : job.progress } });
    return changed.count === 1;
  });
}
async function binding(job: MediaRequest, client: SourceDb = db) {
  if (!job.sourceUserId || !job.sourceFingerprint) throw new RequestClientError("This request has no approved source connection.");
  const ctx = job.destination === "cloud" ? await cloudContext(job.sourceUserId, job.providerId ?? "", client) : job.destination === "local" ? await qbitContext(job.sourceUserId, client) : null;
  if (!ctx || ctx.fingerprint !== job.sourceFingerprint) throw new RequestClientError("The approved source connection changed. Restore its original configuration or inspect the destination before reconciling.");
  return ctx;
}
function cloudTransfer(value: Awaited<ReturnType<ReturnType<typeof getProvider>["getTorrentStatus"]>>): TransferState {
  if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id) || !["queued", "downloading", "finished", "error"].includes(value.phase)) throw new RequestClientError("Cloud provider returned an invalid transfer response.");
  const progress = typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100 ? Math.floor(value.progress) : null;
  return { ref: value.id, phase: value.phase, progress, state: value.phase === "finished" ? "completed" : value.phase };
}
async function publish(job: MediaRequest) {
  if (job.destination !== "cloud" || !job.sharedLibraryId || !job.sourceUserId || !job.providerRef) {
    await finish(job, { nextPollAt: next(365 * 86400) }); return;
  }
  await binding(job);
  const library = await db.sharedLibrary.findFirst({ where: { id: job.sharedLibraryId, sourceUserId: job.sourceUserId, enabled: true, sourceUser: { active: true, role: "admin" } } });
  const item = library && (library.mediaType === "all" || library.mediaType === job.mediaType) ? await db.accountMedia.findFirst({ where: { userId: job.sourceUserId, provider: job.providerId!, providerRef: job.providerRef, credentialFingerprint: job.sourceFingerprint!, phase: "finished", type: job.mediaType } }) : null;
  // Download completion is distinct from successful import and published access.
  if (item && library) {
    await binding(job);
    const current = await db.sharedLibrary.findFirst({ where: { id: library.id, sourceUserId: job.sourceUserId, enabled: true, updatedAt: library.updatedAt, sourceUser: { active: true, role: "admin" } } });
    if (current) { await finish(job, { status: "available", availableAt: new Date(), nextPollAt: next(365 * 86400) }, "The selected release is imported into the shared library. Viewing access still follows the library's grants.", true); return; }
  }
  await finish(job, { nextPollAt: next(15) });
}
/** One bounded operation. The durable submitting state prevents automatic duplicate additions. */
export async function runRequestJob(): Promise<boolean> {
  const claimed = await claim(); if (!claimed) return false;
  const { job, submit } = claimed;
  let confirmedRef: string | undefined;
  let mutationAttempted = false;
  try {
    if (job.status === "downloaded") { await publish(job); return true; }
    // A previous process stopped during submission. Reconcile only known references.
    if (job.status === "submitting" && !submit) {
      if (!job.providerRef) { await finish(job, { status: "attention", error: "Submission was interrupted. Inspect the destination and supply its transfer reference to resume tracking; it will not be submitted again." }, "Submission needs administrator reconciliation."); return true; }
      await finish(job, { status: "queued", nextPollAt: new Date() }, "Resuming read-only tracking of the known transfer."); return true;
    }
    const ctx = await binding(job);
    const isSubmission = submit && !job.providerRef;
    let result: TransferState;
    if (job.destination === "cloud") {
      const cloud = ctx as Awaited<ReturnType<typeof cloudContext>>, provider = getProvider(cloud.provider);
      let value: Awaited<ReturnType<typeof provider.getTorrentStatus>>;
      if (isSubmission) {
        validateMagnet(job.sourceUrl ?? "");
        mutationAttempted = true;
        value = await provider.addTorrent(cloud.creds, job.sourceUrl!);
      } else value = await provider.getTorrentStatus(cloud.creds, job.providerRef!);
      result = cloudTransfer(value);
      if (!isSubmission && result.ref !== job.providerRef) throw new RequestClientError("Cloud provider returned a different transfer reference.");
    } else {
      const local = ctx as Awaited<ReturnType<typeof qbitContext>>, client = new QbitClient(local.settings); await client.login();
      await binding(job);
      if (isSubmission) { mutationAttempted = true; result = await client.add(job.sourceUrl ?? "", job.id); }
      else {
        const transfer = await client.info(job.providerRef!);
        if (!transfer) throw new RequestClientError("The approved torrent is not present in qBittorrent. Inspect the client before resuming tracking.");
        result = transfer;
      }
    }
    confirmedRef = result.ref;
    await binding(job);
    const status = result.phase === "finished" ? "downloaded" : result.phase === "error" ? "failed" : result.phase;
    const changed = status !== job.status || result.progress !== job.progress || result.state !== job.downloadState;
    const completed = result.phase === "finished";
    const committed = await finish(job, { status, providerRef: result.ref, progress: result.progress, downloadState: result.state, error: result.phase === "error" ? "The download client reported a transfer error. Inspect it before resuming tracking." : null, attempts: 0, nextPollAt: next(completed ? 2 : 5), ...(completed ? { downloadedAt: new Date() } : {}) }, changed ? completed ? job.destination === "local" ? "The selected release finished downloading locally. Library import and playback availability are separate." : "The selected release finished downloading in the cloud. Waiting for library import and access." : result.phase === "error" ? "The download client reported a transfer error." : `Selected release ${status}${result.progress === null ? "; progress not reported" : `: ${result.progress}%`}.` : undefined, true);
    if (committed && completed && job.destination === "cloud") {
      try { await queueAccountScans(job.sourceUserId!, { provider: job.providerId as ProviderId, force: true, automatic: false }); } catch { /* request remains downloaded while the administrator can retry/import */ }
    }
    return true;
  } catch (error) {
    if (submit && !mutationAttempted && !job.providerRef) {
      const message = "No transfer was submitted. Fix the connection and approve this request again.";
      await finish(job, { status: "attention", startedAt: null, downloadState: "approval_blocked", error: message, attempts: { increment: 1 }, nextPollAt: next(365 * 86400) }, message);
      return true;
    }
    const submission = job.status === "submitting";
    // The provider's own answer is kept in the log, so a refusal is never reported as an unknown outcome.
    if (submission) void logEvent("warn", "provider_error", `Submitting "${job.name}" to ${job.providerId ?? "the provider"} failed: ${(error instanceof Error ? error.message : "unknown error").replace(/^\[[^\]]*\]\s*/, "").slice(0, 160)}`, { provider: job.providerId ?? undefined, meta: { requestId: job.id } }).catch(() => undefined);
    const refused = submission && job.destination === "cloud" && !job.providerRef ? refusalOf(error) : null;
    if (refused) {
      // The provider said no (and a torrent it had just added was removed again): the request can be approved again once that is fixed.
      const message = `${refused} Fix that, then approve this request again.`;
      await finish(job, { status: "attention", startedAt: null, downloadState: "approval_blocked", error: message, attempts: { increment: 1 }, nextPollAt: next(365 * 86400) }, message);
      return true;
    }
    const changedConnection = error instanceof RequestClientError && /source|connection changed|administrator|configured|configuration/.test(error.message);
    const terminal = submission || changedConnection || job.attempts >= 4;
    const message = submission ? confirmedRef ? "Submission returned a transfer reference, but its connection changed. Restore the original connection and resume tracking; do not add it again." : "Could not confirm submission. Inspect the destination and reconcile its transfer reference before retrying; this request will not be submitted automatically again." : changedConnection ? "The approved connection is no longer available or has changed. Restore it before resuming tracking." : "Could not refresh the transfer. Check the download client and resume tracking if needed.";
    await finish(job, { ...(terminal ? { status: "attention" } : {}), ...(confirmedRef ? { providerRef: confirmedRef } : {}), error: message, attempts: { increment: 1 }, nextPollAt: next(terminal ? 365 * 86400 : Math.min(60, 5 * 2 ** job.attempts)) }, terminal ? message : undefined);
    return true;
  }
}
export async function resumeRequestPolling(requestId: string, actorId: string, reference?: string, authorize?: (tx: Prisma.TransactionClient) => Promise<void>) {
  const job = await db.mediaRequest.findFirst({ where: { id: requestId, sourceUserId: actorId, status: { in: ["attention", "failed"] } } });
  if (!job) throw new RequestClientError("Only the approving administrator can resume an interrupted request in attention or failed state.");
  await binding(job);
  const ref = reference?.trim() || job.providerRef;
  if (!ref || !/^[A-Za-z0-9_-]{1,200}$/.test(ref)) throw new RequestClientError("Inspect the destination first, then supply its existing transfer reference. No transfer will be added again.");
  if (job.destination === "local" && ref !== validateMagnet(job.sourceUrl ?? "")) throw new RequestClientError("The local transfer reference must match the exact approved magnet info hash.");
  return db.$transaction(async tx => {
    await tx.setting.upsert({ where: { key: "requests.worker.lock" }, create: { key: "requests.worker.lock", value: "1" }, update: { value: "1" } });
    await authorize?.(tx);
    await binding(job, tx);
    const actor = await tx.user.findFirst({ where: { id: actorId, active: true, role: "admin" }, select: { id: true } });
    if (!actor) throw new RequestClientError("Your administrator account is no longer active.", 401);
    const changed = await tx.mediaRequest.updateMany({ where: { id: job.id, revision: job.revision, sourceUserId: actorId, status: { in: ["attention", "failed"] } }, data: { status: "queued", providerRef: ref, leaseUntil: null, error: null, attempts: 0, nextPollAt: new Date(), revision: { increment: 1 } } });
    if (!changed.count) throw new RequestClientError("The request changed. Refresh before resuming tracking.");
    await tx.requestEvent.create({ data: { requestId: job.id, status: "queued", message: "Administrator resumed read-only tracking of the existing transfer. No download was submitted again." } });
    return tx.mediaRequest.findUniqueOrThrow({ where: { id: job.id } });
  }, { maxWait: 10000, timeout: 10000 });
}
export function startRequestWorker() {
  let stopped = false, timer: NodeJS.Timeout;
  const tick = async () => { try { if (!stopped) await runRequestJob(); } catch { /* a transient local database failure must not stop the HTTP service */ } if (!stopped) { timer = setTimeout(() => void tick(), 2000); timer.unref(); } };
  timer = setTimeout(() => void tick(), 2000); timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
