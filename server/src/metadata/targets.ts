import { Prisma } from "@prisma/client";
import { db } from "../db";
import { mediaLibrary } from "../library-instance";
import { ageForRating } from "../ratings";
import { MetadataDetails } from "./types";

export type TargetType = "catalog" | "library" | "account";
export interface MetadataTarget { targetType: TargetType; targetId: string; ownerId?: string; name: string; mediaType: "movie" | "series"; year: number | null }
export const ADMIN_TARGET_TYPES: TargetType[] = ["catalog", "library"];
export const TARGET_TYPES: TargetType[] = ["catalog", "library", "account"];
export const LOCK_FIELDS = ["name", "year", "description", "genres", "posterUrl", "backdropUrl"] as const;
export async function metadataTarget(type: TargetType, id: string): Promise<MetadataTarget | null> {
  if (type === "account") return accountTarget(id);
  if (type === "library") return mediaLibrary.metadataTarget(id);
  const title = await db.title.findUnique({ where: { id } });
  return title ? { targetType: type, targetId: id, name: title.name, mediaType: title.type === "series" ? "series" : "movie", year: title.year } : null;
}
export async function metadataTargets(type: TargetType, cursor: string, limit: number): Promise<MetadataTarget[]> {
  if (type === "account") return accountTargets(cursor, limit);
  if (type === "library") return mediaLibrary.metadataTargets(cursor, limit);
  return (await db.title.findMany({ where: { id: { gt: cursor } }, orderBy: { id: "asc" }, take: limit, select: { id: true, name: true, type: true, year: true } }))
    .map(title => ({ targetType: type, targetId: title.id, name: title.name, mediaType: title.type === "series" ? "series" : "movie", year: title.year }));
}
/** Catalog playback sources and media type are never inferred or changed here. */
export async function applyTargetMetadata(tx: Prisma.TransactionClient, target: MetadataTarget, details: MetadataDetails, previous: MetadataDetails | null, locks: string[], manual: boolean, applied: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (target.targetType === "account") return applyAccountMetadata(tx, target, details, locks, manual, applied);
  if (target.targetType !== "catalog") return {};
  const title = await tx.title.findUnique({ where: { id: target.targetId } });
  if (!title) throw new Error("metadata-target-removed");
  const update: Record<string, unknown> = {}, managed = { ...applied };
  for (const field of LOCK_FIELDS) {
    if (locks.includes(field)) continue;
    const current = title[field];
    const owned = Object.prototype.hasOwnProperty.call(applied, field) && JSON.stringify(current) === JSON.stringify(applied[field]);
    const next = field === "genres" ? JSON.stringify(details.genres) : details[field];
    const empty = current === null || current === "" || current === "[]";
    // Initial automatic enrichment fills gaps. Later refreshes replace only
    // provider-managed values still unchanged by an administrator.
    if (manual || empty || owned) {
      if (next !== null && next !== "" && next !== "[]") { update[field] = next; managed[field] = next; }
    } else if (Object.prototype.hasOwnProperty.call(managed, field)) delete managed[field];
  }
  if (Object.keys(update).length) await tx.title.update({ where: { id: target.targetId }, data: update });
  return managed;
}

async function accountTarget(id: string): Promise<MetadataTarget | null> {
  const item = await db.accountMedia.findFirst({ where: { id, user: { active: true } } });
  return item ? { targetType: "account", targetId: item.id, ownerId: item.userId, name: item.name, mediaType: item.type === "series" ? "series" : "movie", year: item.year } : null;
}
async function accountTargets(cursor: string, limit: number): Promise<MetadataTarget[]> {
  return (await db.accountMedia.findMany({ where: { id: { gt: cursor }, user: { active: true } }, orderBy: { id: "asc" }, take: limit }))
    .map(item => ({ targetType: "account", targetId: item.id, ownerId: item.userId, name: item.name, mediaType: item.type === "series" ? "series" : "movie", year: item.year }));
}
async function applyAccountMetadata(tx: Prisma.TransactionClient, target: MetadataTarget, details: MetadataDetails, locks: string[], manual: boolean, applied: Record<string, unknown>): Promise<Record<string, unknown>> {
  const item = await tx.accountMedia.findFirst({ where: { id: target.targetId, userId: target.ownerId } });
  if (!item) throw new Error("metadata-target-removed");
  const managed = { ...applied }, update: { name?: string; year?: number } = {};
  if (!locks.includes("name") && details.name && (manual || !item.name || applied.name === item.name)) { update.name = details.name; managed.name = details.name; }
  if (!locks.includes("year") && details.year !== null && (manual || item.year === null || applied.year === item.year)) { update.year = details.year; managed.year = details.year; }
  // The title's age rating follows its metadata unless an administrator set one by hand.
  const ratingLabel = (item.ratingOverride ?? details.contentRating ?? "").trim() || null;
  await tx.accountMedia.update({ where: { id: item.id }, data: { ...update, ratingLabel, minAge: ageForRating(ratingLabel) } });
  return managed;
}
