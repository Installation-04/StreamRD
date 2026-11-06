import { mediaKeyFor } from "../progress";
import { chooseFile } from "./files";
import { createHmac } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { getProvider } from "./registry";
import { ProviderCredentials, ProviderError, ProviderId, UnrestrictedLink } from "./types";

export class PendingSourceError extends ProviderError {
  constructor(id: ProviderId, public readonly progress: number) {
    super(id, `Torrent not ready yet (${progress}%) — try again shortly`);
  }
}

/** Coalesces in-process work; SQLite leases also serialize independent workers. */
export class SourceJobs {
  private pending = new Map<string, Promise<UnrestrictedLink>>();

  resolve(userId: string, id: ProviderId, creds: ProviderCredentials, source: string, fileToken?: string): Promise<UnrestrictedLink> {
    // Include account and credentials so keys/URLs cannot cross user boundaries.
    const key = createHmac("sha256", config.jwtSecret)
      .update(JSON.stringify([userId, id, creds.apiKey, creds.baseUrl ?? "", source])).digest("hex");
    const taskKey = `${key}:${fileToken ?? "auto"}`;
    const existing = this.pending.get(taskKey);
    if (existing) return existing;
    const task = this.run(key, userId, id, creds, source, fileToken);
    this.pending.set(taskKey, task);
    void task.finally(() => {
      if (this.pending.get(taskKey) === task) this.pending.delete(taskKey);
    }).catch(() => {});
    return task;
  }

  private async run(key: string, userId: string, id: ProviderId, creds: ProviderCredentials, source: string, fileToken?: string): Promise<UnrestrictedLink> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await db.playbackSourceJob.upsert({
      where: { key }, update: {},
      create: { key, userId, provider: id, expiresAt, leaseUntil: new Date(0) },
    });
    const leaseUntil = new Date(Math.max(Date.now() + 60_000, (creds.deadline ?? Date.now() + 300_000) + 30_000));
    const claimed = await db.playbackSourceJob.updateMany({
      where: { key, leaseUntil: { lte: now } }, data: { leaseUntil },
    });
    if (!claimed.count) throw new PendingSourceError(id, 0);
    try {
      const job = await db.playbackSourceJob.findUniqueOrThrow({ where: { key } });
      const provider = getProvider(id);
      const ref = job.expiresAt > now ? job.providerRef : null;
      const status = ref ? await provider.getTorrentStatus(creds, ref) : await provider.addTorrent(creds, source);
      if (!ref) {
        // Persist before choosing/unrestricting, including unfinished torrents.
        await db.playbackSourceJob.update({ where: { key }, data: { providerRef: status.id, expiresAt } });
      }
      if (status.phase === "finished") {
        const file = chooseFile(id, key, status, fileToken);
        const mediaKey = mediaKeyFor(source, file.path, file.size);
        if (file.direct) return { provider: id, url: file.link, filename: file.path.split("/").pop()!, filesize: file.size, mediaKey };
        // Await under the lease so another worker cannot resolve concurrently.
        return { ...await provider.unrestrictLink(creds, file.link), mediaKey };
      }
      if (status.phase === "error") throw new ProviderError(id, "Torrent failed at provider");
      throw new PendingSourceError(id, status.progress);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        await db.playbackSourceJob.update({ where: { key }, data: { providerRef: null } });
      }
      throw err;
    } finally {
      await db.playbackSourceJob.updateMany({ where: { key, leaseUntil }, data: { leaseUntil: new Date(0) } });
    }
  }
}
export const sourceJobs = new SourceJobs();
