import { Prisma } from "@prisma/client";
import { db } from "../db";
import { mediaLibrary } from "../library-instance";
import { ageForRating } from "../ratings";
import { idKey, refreshPrimaries, titleKey } from "../versions";
import { MetadataDetails } from "./types";
export type TargetType = "catalog" | "library" | "account";
export interface MetadataTarget { targetType: TargetType; targetId: string; ownerId?: string; name: string; mediaType: "movie" | "series"; year: number | null }
export const ADMIN_TARGET_TYPES: TargetType[] = ["library"];
export const TARGET_TYPES: TargetType[] = ["library", "account"];
export const LOCK_FIELDS = ["name", "year", "description", "genres", "posterUrl", "backdropUrl"] as const;
export async function metadataTarget(type: TargetType, id: string): Promise<MetadataTarget | null> { return type === "account" ? accountTarget(id) : type === "library" ? mediaLibrary.metadataTarget(id) : null; }
export async function metadataTargets(type: TargetType, cursor: string, limit: number): Promise<MetadataTarget[]> { return type === "account" ? accountTargets(cursor, limit) : type === "library" ? mediaLibrary.metadataTargets(cursor, limit) : []; }
export async function applyTargetMetadata(_tx: Prisma.TransactionClient, _target: MetadataTarget, _details: MetadataDetails, _previous: MetadataDetails | null, _locks: string[], _manual: boolean, _applied: Record<string, unknown>): Promise<Record<string, unknown>> { return _target.targetType === "account" ? applyAccountMetadata(_tx, _target, _details, _locks, _manual, _applied) : {}; }

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
  // Versions of one title share a key: the provider id once matched, else the cleaned name, year and type.
  const groupKey = idKey(details) ?? titleKey(update.name ?? item.name, update.year ?? item.year, item.type);
  await tx.accountMedia.update({ where: { id: item.id }, data: { ...update, ratingLabel, minAge: ageForRating(ratingLabel), groupKey } });
  await refreshPrimaries(tx, item.userId, [item.groupKey, groupKey]);
  return managed;
}
