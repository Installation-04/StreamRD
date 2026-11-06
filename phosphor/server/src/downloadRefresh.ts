import { createHash } from "node:crypto";
import { DebridConfig, DownloadJob } from "@prisma/client";
import { db } from "./db";
import { debridManager } from "./providers/manager";
import { ProviderError, ProviderId } from "./providers/types";
import { BoundedExecutor, CapacityError } from "./util/boundedExecutor";
import { TtlCache } from "./util/ttlCache";
export interface RefreshResult { job: DownloadJob; error?: string; retryable?: boolean; retryAfterMs?: number }
const cache = new TtlCache<RefreshResult>(3000);
const executor = new BoundedExecutor(4, 64);
export const clearDownloadRefreshCache = () => cache.clear();
const retryable = (err: unknown) => err instanceof CapacityError || (err instanceof ProviderError && (
  [408, 429].includes(err.statusCode ?? 0) || (err.statusCode ?? 0) >= 500 || /timed out|fetch failed|network|ECONN|socket/i.test(err.message)
));

/** Call after verifying the job belongs to the active account and still exists. */
export function refreshDownload(job: DownloadJob, cfg: DebridConfig): Promise<RefreshResult> {
  const key = createHash("sha256").update(JSON.stringify([job.userId, job.id, job.provider, job.providerRef, cfg])).digest("hex");
  return cache.getOrSet(key, async () => {
    let result: Awaited<ReturnType<typeof debridManager.refresh>>;
    try {
      result = await executor.run(() => debridManager.refresh(cfg, job.provider as ProviderId, job.providerRef!));
    } catch (err) {
      const error = (err as Error).message;
      const transient = retryable(err);
      // Database failures stay outside this catch: do not turn them into provider errors.
      await db.downloadJob.updateMany({ where: { id: job.id, userId: job.userId, status: { in: ["queued", "downloading"] } }, data: { ...(transient ? {} : { status: "error" }), error } });
      const current = await db.downloadJob.findFirstOrThrow({ where: { id: job.id, userId: job.userId } });
      return { job: current, error, retryable: transient, ...(transient ? { retryAfterMs: 8000 } : {}) };
    }
    const { status, stream } = result;
    await db.downloadJob.updateMany({
      where: { id: job.id, userId: job.userId, status: { in: ["queued", "downloading"] } },
      data: { status: stream ? "finished" : status.phase === "finished" ? "downloading" : status.phase, progress: status.progress, streamUrl: stream?.url ?? job.streamUrl, filename: stream?.filename ?? job.filename, error: null },
    });
    return { job: await db.downloadJob.findFirstOrThrow({ where: { id: job.id, userId: job.userId } }) };
  });
}
