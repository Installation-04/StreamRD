import { AccountMedia } from "@prisma/client";
import { db } from "../db";
import { queueAutomaticTargets, queueTarget, storedMetadata } from "./automation";
import { getMetadataSettings } from "./settings";

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
    provider: { configured: Boolean(settings.tmdbApiKey || settings.omdbApiKey), automatic: settings.automatic },
  };
}
/** Queue the caller's own unmatched, review, failed and never-started titles again (bounded per call). */
export async function rematchAccountMetadata(userId: string, limit = 500) {
  const settings = await getMetadataSettings();
  if (!settings.tmdbApiKey && !settings.omdbApiKey) return { queued: 0, remaining: 0, configured: false };
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
