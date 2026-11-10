import { db } from "./db";

/**
 * Age ratings and viewing limits. A rating label (MPAA, US TV, or a plain age such as "12") becomes a minimum age; a user's limit is the
 * highest minimum age they may see. A title with no rating (minAge null) is never shown to a limited user: an unknown title is not
 * assumed to be suitable. Administrators are never limited.
 */
const AGES: Record<string, number> = {
  "G": 0, "TV-Y": 0, "TV-G": 0, "U": 0, "ALL": 0, "TV-Y7": 7, "TV-Y7-FV": 7, "PG": 8, "TV-PG": 8, "PG-13": 13, "TV-14": 14, "R": 17, "TV-MA": 17, "NC-17": 18, "X": 18,
};
export function ageForRating(label: string | null | undefined): number | null {
  const value = (label ?? "").trim().toUpperCase().replace(/^(?:US|USA)[:\s-]+/, "").replace(/\s+/g, "");
  if (!value) return null;
  if (value in AGES) return AGES[value];
  const age = /^(?:FSK|BBFC|AGE)?-?(\d{1,2})(?:A|\+)?$/.exec(value);
  return age && Number(age[1]) <= 21 ? Number(age[1]) : null;
}
/** What an administrator can choose for a person. `maxAge: null` means no limit. */
export const VIEWING_LIMITS = [
  { id: "kids", maxAge: 7, label: "Kids", detail: "G, TV-Y, TV-G, TV-Y7" },
  { id: "preteen", maxAge: 8, label: "Pre-teens", detail: "up to PG and TV-PG" },
  { id: "teens", maxAge: 14, label: "Teens", detail: "up to PG-13 and TV-14" },
  { id: "mature", maxAge: 17, label: "Mature", detail: "up to R and TV-MA" },
] as const;
export const LIMIT_AGES: number[] = VIEWING_LIMITS.map(limit => limit.maxAge);

/** The rating stored with matched metadata, read without importing the metadata module (which depends on this one). */
function storedRating(data: string): string | null {
  try { const value = JSON.parse(data)?.contentRating; return typeof value === "string" ? value : null; } catch { return null; }
}
/** Recomputes one title's rating from its administrator override or its stored metadata. */
export async function syncAccountRating(itemId: string): Promise<{ ratingLabel: string | null; minAge: number | null }> {
  const item = await db.accountMedia.findUnique({ where: { id: itemId }, select: { id: true, userId: true, ratingOverride: true } });
  if (!item) return { ratingLabel: null, minAge: null };
  const record = await db.metadataRecord.findFirst({ where: { targetType: "account", targetId: itemId, ownerId: item.userId }, select: { data: true } });
  const label = (item.ratingOverride ?? (record ? storedRating(record.data) : null) ?? "").trim() || null;
  const rating = { ratingLabel: label, minAge: ageForRating(label) };
  await db.accountMedia.update({ where: { id: itemId }, data: rating });
  return rating;
}
/** Fills in ratings for titles that already have stored metadata (upgrades, or ratings that arrived before this feature). Idempotent. */
export async function backfillRatings(limit = 5000): Promise<number> {
  let changed = 0;
  const items = await db.accountMedia.findMany({ where: { ratingLabel: null, minAge: null }, select: { id: true }, take: limit });
  for (const { id } of items) { const rating = await syncAccountRating(id); if (rating.ratingLabel) changed++; }
  return changed;
}
