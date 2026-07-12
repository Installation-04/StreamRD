import { db } from "./db";

/**
 * Lightweight in-process counters plus DB-derived playback stats.
 * Counters reset on restart; durable analytics come from PlaybackLog.
 */
const counters = new Map<string, number>();

export function increment(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

export function resetCounters(): void {
  counters.clear();
}

export interface PlaybackStats {
  totalPlays: number;
  playsByProvider: Record<string, number>;
  playsLastHour: number;
  recentFailures: number;
}

export async function playbackStats(): Promise<PlaybackStats> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [totalPlays, byProvider, playsLastHour, recentFailures] =
    await Promise.all([
      db.playbackLog.count(),
      db.playbackLog.groupBy({ by: ["providerUsed"], _count: { _all: true } }),
      db.playbackLog.count({ where: { createdAt: { gte: hourAgo } } }),
      db.playbackLog.count({
        where: { success: false, createdAt: { gte: dayAgo } },
      }),
    ]);
  return {
    totalPlays,
    playsByProvider: Object.fromEntries(
      byProvider.map((row) => [row.providerUsed, row._count._all])
    ),
    playsLastHour,
    recentFailures,
  };
}
