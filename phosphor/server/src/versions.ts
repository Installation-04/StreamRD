import { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * Versions of one title. A debrid account often holds the same film twice (1080p and 4K) or a show as several season packs. Those rows
 * share a `groupKey`; exactly one of them, the primary, is shown in library lists, and the title page offers the others as versions.
 * Nothing is deleted or merged in the database: grouping only decides what a list shows.
 */
type Client = Pick<Prisma.TransactionClient, "$executeRawUnsafe">;
const normalize = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
/** Names the title from its cleaned name, year and type; null when the name says nothing. */
export function titleKey(name: string | null | undefined, year: number | null | undefined, type: string | null | undefined): string | null {
  const words = normalize(name ?? ""); if (!words) return null;
  return `${type === "series" ? "series" : "movie"}|${words}|${year ?? ""}`;
}
/** A matched title is named by its provider id, which joins different spellings and release names of the same film. */
export function idKey(details: { imdbId?: string | null; tmdbId?: string | null } | null | undefined): string | null {
  if (details?.imdbId && /^tt\d{7,10}$/.test(details.imdbId)) return `imdb:${details.imdbId}`;
  if (details?.tmdbId && /^\d{1,10}$/.test(String(details.tmdbId))) return `tmdb:${details.tmdbId}`;
  return null;
}
/** A short label for a release name: resolution, source, codec and HDR, for example "1080p · WEB · HEVC". */
export function qualityLabel(release: string | null | undefined): string | null {
  const text = release ?? "", parts: string[] = [];
  const resolution = /(?:^|[^a-z0-9])(2160p|4k|uhd|1080[pi]|720p|576p|480p)(?:[^a-z0-9]|$)/i.exec(text)?.[1]?.toLowerCase();
  if (resolution) parts.push(["2160p", "4k", "uhd"].includes(resolution) ? "4K" : resolution.replace("i", "p"));
  if (/remux/i.test(text)) parts.push("Remux");
  else if (/(?:blu-?ray|bdrip|brrip)/i.test(text)) parts.push("BluRay");
  else if (/(?:web-?dl|web-?rip|(?:^|[^a-z0-9])web(?:[^a-z0-9]|$))/i.test(text)) parts.push("WEB");
  else if (/hdtv/i.test(text)) parts.push("HDTV");
  else if (/dvd-?rip/i.test(text)) parts.push("DVD");
  if (/(?:x265|h[ .]?265|hevc)/i.test(text)) parts.push("HEVC");
  else if (/(?:x264|h[ .]?264|avc)/i.test(text)) parts.push("H.264");
  if (/(?:dolby[ .]?vision|(?:^|[^a-z0-9])dv(?:[^a-z0-9]|$)|hdr10\+?|(?:^|[^a-z0-9])hdr(?:[^a-z0-9]|$))/i.test(text)) parts.push("HDR");
  return parts.length ? parts.join(" · ") : null;
}

/** Chooses the primary version of each named group: one whose link works, then a finished one, then the newest. */
export async function refreshPrimaries(client: Client, userId: string, keys: Array<string | null | undefined>): Promise<void> {
  const unique = [...new Set(keys.filter((key): key is string => Boolean(key)))];
  for (let offset = 0; offset < unique.length; offset += 200) {
    const batch = unique.slice(offset, offset + 200);
    await client.$executeRawUnsafe(
      `UPDATE "AccountMedia" SET "isPrimary" = CASE WHEN "id" = (SELECT b."id" FROM "AccountMedia" b WHERE b."userId" = "AccountMedia"."userId" AND b."groupKey" = "AccountMedia"."groupKey" ORDER BY (b."health" <> 'broken') DESC, (b."phase" = 'finished') DESC, b."createdAt" DESC, b."id" DESC LIMIT 1) THEN 1 ELSE 0 END WHERE "userId" = ? AND "groupKey" IN (${batch.map(() => "?").join(",")})`,
      userId, ...batch);
  }
}

/** Names titles that existed before grouping did, using stored metadata where there is one. Idempotent; run at start. */
export async function backfillGroups(batch = 2000, rounds = 50): Promise<number> {
  let named = 0;
  for (let round = 0; round < rounds; round++) {
    const rows = await db.accountMedia.findMany({ where: { groupKey: null }, select: { id: true, userId: true, name: true, year: true, type: true }, orderBy: { id: "asc" }, take: batch });
    if (!rows.length) break;
    const touched = new Map<string, Set<string>>();
    for (const row of rows) {
      const record = await db.metadataRecord.findFirst({ where: { targetType: "account", targetId: row.id, ownerId: row.userId }, select: { data: true } });
      let details: { imdbId?: string | null; tmdbId?: string | null } | null = null;
      try { details = record ? JSON.parse(record.data) : null; } catch { details = null; }
      // An unnameable title gets a key of its own so it is not picked up again and again.
      const key = idKey(details) ?? titleKey(row.name, row.year, row.type) ?? `item:${row.id}`;
      await db.accountMedia.update({ where: { id: row.id }, data: { groupKey: key } });
      if (!touched.has(row.userId)) touched.set(row.userId, new Set());
      touched.get(row.userId)!.add(key); named++;
    }
    for (const [userId, keys] of touched) await refreshPrimaries(db, userId, [...keys]);
    if (rows.length < batch) break;
  }
  return named;
}

/** The other versions of a title that the viewer may see, newest first; empty when there is only one. */
export async function versionViews(visible: Prisma.AccountMediaWhereInput, item: { userId: string; groupKey: string | null; id: string }) {
  if (!item.groupKey) return [];
  const rows = await db.accountMedia.findMany({ where: { AND: [visible, { userId: item.userId, groupKey: item.groupKey }] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 });
  if (rows.length < 2) return [];
  return rows.map(row => ({ id: row.id, quality: qualityLabel(row.releaseName), release: row.releaseName?.slice(0, 160) ?? null, phase: row.phase, createdAt: row.createdAt.toISOString(), current: row.id === item.id }));
}
