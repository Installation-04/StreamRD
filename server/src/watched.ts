import { AccountMedia } from "@prisma/client";
import { db } from "./db";

type Key = Pick<AccountMedia, "id" | "userId" | "groupKey">;
const keyOf = (ownerId: string, groupKey: string) => `${ownerId}|${groupKey}`;
/** The marker row a manual "mark as watched" leaves; real playback rows use the file's own key. */
export const MANUAL_MEDIA_KEY = "manual";

/** Ids of every version of the titles these items belong to, with the title each version belongs to. */
async function versionsOf(items: Key[]) {
  const grouped = items.filter(item => item.groupKey);
  if (!grouped.length) return [];
  return db.accountMedia.findMany({
    where: { OR: [...new Set(grouped.map(item => item.userId))].map(userId => ({ userId, groupKey: { in: grouped.filter(item => item.userId === userId).map(item => item.groupKey!) } })) },
    select: { id: true, userId: true, groupKey: true },
  });
}

/** Which of these items are watched by the viewer. Watching any version of a title counts for the title. */
export async function watchedIds(userId: string, items: Key[]): Promise<Set<string>> {
  const versions = await versionsOf(items);
  if (!versions.length) return new Set();
  const done = await db.sharedLibraryProgress.findMany({ where: { userId, completed: true, itemId: { in: versions.map(version => version.id) } }, select: { itemId: true } });
  const finished = new Set(done.map(row => row.itemId)), watchedTitles = new Set(versions.filter(version => finished.has(version.id)).map(version => keyOf(version.userId, version.groupKey!)));
  return new Set(items.filter(item => item.groupKey && watchedTitles.has(keyOf(item.userId, item.groupKey))).map(item => item.id));
}

/** Marks the whole title watched (every version) or unwatched, clearing any half-finished resume point. Returns the new state. */
export async function setWatched(userId: string, item: Key, on: boolean): Promise<boolean | "ungrouped"> {
  if (!item.groupKey) return "ungrouped";
  const ids = (await versionsOf([item])).map(version => version.id);
  if (!on) {
    await db.$transaction([
      db.sharedLibraryProgress.deleteMany({ where: { userId, itemId: { in: ids }, mediaKey: MANUAL_MEDIA_KEY } }),
      db.sharedLibraryProgress.updateMany({ where: { userId, itemId: { in: ids } }, data: { completed: false, positionSeconds: 0 } }),
    ]);
    return false;
  }
  await db.$transaction([
    db.sharedLibraryProgress.updateMany({ where: { userId, itemId: { in: ids } }, data: { completed: true } }),
    db.sharedLibraryProgress.upsert({
      where: { userId_itemId_mediaKey: { userId, itemId: item.id, mediaKey: MANUAL_MEDIA_KEY } },
      create: { userId, itemId: item.id, mediaKey: MANUAL_MEDIA_KEY, activeSessionId: MANUAL_MEDIA_KEY, positionSeconds: 1, durationSeconds: 1, completed: true },
      update: { completed: true },
    }),
  ]);
  return true;
}

/** A filter that leaves out every title the viewer has finished (any version), for the "Unwatched" view. Null when nothing is watched yet. */
export async function unwatchedWhere(userId: string): Promise<{ NOT: { OR: Array<{ userId: string; groupKey: { in: string[] } }> } } | null> {
  const done = await db.sharedLibraryProgress.findMany({ where: { userId, completed: true }, select: { itemId: true }, take: 5000 });
  if (!done.length) return null;
  const titles = await db.accountMedia.findMany({ where: { id: { in: done.map(row => row.itemId) }, groupKey: { not: null } }, select: { userId: true, groupKey: true } });
  const byOwner = new Map<string, Set<string>>();
  for (const title of titles) byOwner.set(title.userId, (byOwner.get(title.userId) ?? new Set()).add(title.groupKey!));
  if (!byOwner.size) return null;
  return { NOT: { OR: [...byOwner].map(([owner, keys]) => ({ userId: owner, groupKey: { in: [...keys] } })) } };
}
