import { AccountMedia } from "@prisma/client";
import { db } from "./db";
import { sharedMediaWhere, visibleSharedLibraryWhere } from "./shared-libraries";

/** The most titles one viewer can keep on their list. */
export const MAX_FAVORITES = 500;
const keyOf = (ownerId: string, groupKey: string) => `${ownerId}|${groupKey}`;

/** Which of these items are on the viewer's list. Every version of a title counts as listed when the title is. */
export async function favoriteIds(userId: string, items: Pick<AccountMedia, "id" | "userId" | "groupKey">[]): Promise<Set<string>> {
  const grouped = items.filter(item => item.groupKey);
  if (!grouped.length) return new Set();
  const rows = await db.libraryFavorite.findMany({ where: { userId, OR: [...new Set(grouped.map(item => item.userId))].map(ownerId => ({ ownerId, groupKey: { in: grouped.filter(item => item.userId === ownerId).map(item => item.groupKey!) } })) }, select: { ownerId: true, groupKey: true } });
  const listed = new Set(rows.map(row => keyOf(row.ownerId, row.groupKey)));
  return new Set(grouped.filter(item => listed.has(keyOf(item.userId, item.groupKey!))).map(item => item.id));
}

/** Adds a title (or removes it); returns false when the list is full. */
export async function setFavorite(userId: string, item: Pick<AccountMedia, "userId" | "groupKey">, on: boolean): Promise<boolean | "full" | "ungrouped"> {
  if (!item.groupKey) return "ungrouped";
  const where = { userId_ownerId_groupKey: { userId, ownerId: item.userId, groupKey: item.groupKey } };
  if (!on) { await db.libraryFavorite.deleteMany({ where: { userId, ownerId: item.userId, groupKey: item.groupKey } }); return false; }
  if (!await db.libraryFavorite.findUnique({ where }) && await db.libraryFavorite.count({ where: { userId } }) >= MAX_FAVORITES) return "full";
  await db.libraryFavorite.upsert({ where, create: { userId, ownerId: item.userId, groupKey: item.groupKey }, update: {} });
  return true;
}

/**
 * The viewer's list, newest first: for each listed title the version a library shows (its primary one), taken only from libraries
 * the viewer may see and only within their viewing limit. A title that is no longer visible stays on the list but is not returned.
 */
export async function favoriteItems(userId: string, ageLimit: number | null, limit = 100): Promise<Array<{ libraryId: string; item: AccountMedia }>> {
  const favorites = await db.libraryFavorite.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { ownerId: "asc" }, { groupKey: "asc" }], take: MAX_FAVORITES });
  if (!favorites.length) return [];
  const libraries = await db.sharedLibrary.findMany({ where: visibleSharedLibraryWhere(userId), orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
  const pending = new Set(favorites.map(favorite => keyOf(favorite.ownerId, favorite.groupKey))), found = new Map<string, { libraryId: string; item: AccountMedia }>();
  for (const library of libraries) {
    if (!pending.size) break;
    const keys = favorites.filter(favorite => favorite.ownerId === library.sourceUserId && pending.has(keyOf(favorite.ownerId, favorite.groupKey))).map(favorite => favorite.groupKey);
    if (!keys.length) continue;
    const items = await db.accountMedia.findMany({ where: { AND: [await sharedMediaWhere(library, ageLimit), { isPrimary: true, userId: library.sourceUserId, groupKey: { in: keys } }] } });
    for (const item of items) { const key = keyOf(item.userId, item.groupKey!); if (pending.delete(key)) found.set(key, { libraryId: library.id, item }); }
  }
  return favorites.flatMap(favorite => found.get(keyOf(favorite.ownerId, favorite.groupKey)) ?? []).slice(0, limit);
}
