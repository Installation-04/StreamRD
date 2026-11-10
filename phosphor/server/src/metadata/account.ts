import { AccountMedia } from "@prisma/client";
import { db } from "../db";
import { queueAutomaticTargets, queueTarget, storedMetadata } from "./automation";
import { activeProvider, getMetadataSettings } from "./settings";
import { classifyTitle } from "../media-filter";

/** Only decorate rows already selected through the caller's account boundary. */
export async function decorateAccountMedia<T extends { id: string; userId: string }>(items: T[]) {
  const records = new Map<string, { ownerId: string | null; data: string; status: string }>();
  for (let offset = 0; offset < items.length; offset += 100) {
    const batch = items.slice(offset, offset + 100);
    const found = await db.metadataRecord.findMany({ where: { targetType: "account", targetId: { in: batch.map(item => item.id) }, ownerId: { in: [...new Set(batch.map(item => item.userId))] } }, select: { targetId: true, ownerId: true, data: true, status: true } });
    for (const record of found) records.set(record.targetId, record);
  }
  return items.map(item => {
    const row = records.get(item.id), owned = row?.ownerId === item.userId;
    return { ...item, metadata: owned ? storedMetadata(row.data) : null, metadataStatus: owned ? row.status : null };
  });
}
export async function queueImportedMetadata(items: AccountMedia[]) {
  await queueAutomaticTargets(items.map(item => ({ targetType: "account", targetId: item.id, ownerId: item.userId,
    name: item.name, mediaType: item.type === "series" ? "series" : "movie", year: item.year })));
}

const targetOf = (item: AccountMedia) => ({ targetType: "account" as const, targetId: item.id, ownerId: item.userId, name: item.name, mediaType: item.type === "series" ? "series" as const : "movie" as const, year: item.year });

/** Owner-only counts; titles, names and other users' libraries are never involved. */
export async function accountMetadataSummary(userId: string) {
  const [total, groups, settings] = await Promise.all([
    db.accountMedia.count({ where: { userId } }),
    db.metadataRecord.groupBy({ by: ["status"], where: { targetType: "account", ownerId: userId }, _count: { _all: true } }),
    getMetadataSettings(),
  ]);
  const count = (...statuses: string[]) => groups.filter(group => statuses.includes(group.status)).reduce((sum, group) => sum + group._count._all, 0);
  const recorded = groups.reduce((sum, group) => sum + group._count._all, 0);
  return {
    total, matched: count("matched"), matching: count("queued", "processing"), review: count("review"), unmatched: count("unmatched"), error: count("error"),
    notStarted: Math.max(0, total - recorded),
    provider: { configured: true, source: activeProvider(settings), automatic: settings.automatic },
  };
}
/** Queue the caller's own unmatched, review, failed and never-started titles again (bounded per call). */
export async function rematchAccountMetadata(userId: string, limit = 500) {
  const settings = await getMetadataSettings();
  const retry = await db.metadataRecord.findMany({ where: { targetType: "account", ownerId: userId, status: { in: ["review", "unmatched", "error"] } }, orderBy: { id: "asc" }, take: limit, select: { targetId: true } });
  let ids = retry.map(row => row.targetId);
  if (ids.length < limit) {
    const fresh = await db.$queryRaw<Array<{ id: string }>>`SELECT a.id FROM AccountMedia a LEFT JOIN MetadataRecord m ON m.targetType = 'account' AND m.targetId = a.id WHERE a.userId = ${userId} AND m.id IS NULL ORDER BY a.id LIMIT ${limit - ids.length}`;
    ids = ids.concat(fresh.map(row => row.id));
  }
  const items = ids.length ? await db.accountMedia.findMany({ where: { id: { in: ids }, userId, user: { active: true } } }) : [];
  let queued = 0;
  for (const item of items) if (await queueTarget(targetOf(item), true, true, settings)) queued++;
  const after = await accountMetadataSummary(userId);
  return { queued, remaining: after.review + after.unmatched + after.error + after.notStarted, configured: true };
}

/**
 * Find (and optionally remove) entries in the caller's own library that are not movies or shows: games, software,
 * music, books and names with no readable title. Only the local library rows go; the provider's torrents and every
 * other user's library are untouched, and a later scan skips these names too.
 */
export async function cleanupAccountLibrary(userId: string, apply: boolean) {
  const counts: Record<string, number> = {}, samples: Array<{ name: string; reason: string }> = [], ids: string[] = [];
  for (let cursor = ""; ;) {
    const page = await db.accountMedia.findMany({ where: { userId, id: { gt: cursor } }, orderBy: { id: "asc" }, take: 500, select: { id: true, name: true } });
    if (!page.length) break;
    cursor = page[page.length - 1].id;
    for (const item of page) {
      const verdict = classifyTitle(item.name);
      if (verdict.keep) continue;
      counts[verdict.reason] = (counts[verdict.reason] ?? 0) + 1; ids.push(item.id);
      if (samples.length < 40) samples.push({ name: item.name.slice(0, 120), reason: verdict.reason });
    }
  }
  let removed = 0;
  if (apply) {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      removed += (await db.accountMedia.deleteMany({ where: { id: { in: batch }, userId } })).count;
      await db.metadataRecord.deleteMany({ where: { targetType: "account", targetId: { in: batch }, ownerId: userId } });
    }
  }
  return { matched: ids.length, removed, applied: apply, counts, samples };
}
