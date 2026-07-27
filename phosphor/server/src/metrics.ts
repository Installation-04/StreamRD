import { db } from "./db";

/** Lightweight in-process counters. Reset on restart. */
const counters = new Map<string, number>();

export function increment(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

export interface DownloadStats {
  totalJobs: number;
  jobsByProvider: Record<string, number>;
  jobsLastHour: number;
  recentFailures: number;
}

export async function downloadStats(): Promise<DownloadStats> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [totalJobs, byProvider, jobsLastHour, recentFailures] = await Promise.all([
    db.downloadJob.count(),
    db.downloadJob.groupBy({ by: ["provider"], _count: { _all: true } }),
    db.downloadJob.count({ where: { createdAt: { gte: hourAgo } } }),
    db.downloadJob.count({ where: { status: "error", createdAt: { gte: dayAgo } } }),
  ]);
  return {
    totalJobs,
    jobsByProvider: Object.fromEntries(byProvider.map((r) => [r.provider, r._count._all])),
    jobsLastHour,
    recentFailures,
  };
}
