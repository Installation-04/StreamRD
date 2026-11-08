import { MediaRequest, Prisma } from "@prisma/client";
import { db } from "../db";
import { currentAccountMediaFilter } from "../account-library";
import { visibleSharedLibraryWhere, sharedMediaWhere } from "../shared-libraries";
import { MetadataDetails } from "../metadata/types";
import { storedMetadata } from "../metadata/automation";
import { SessionClaims } from "../auth/jwt";

export const REQUEST_STATUSES = ["requested", "approved", "submitting", "queued", "downloading", "downloaded", "available", "rejected", "cancelled", "attention", "failed"] as const;
export const ACTIVE_REQUEST_STATUSES = ["requested", "approved", "submitting", "queued", "downloading", "attention"];
export class RequestError extends Error { constructor(message: string, public status = 400) { super(message); } }
export type RequestDb = Prisma.TransactionClient;
export async function assertRequestActor(session: SessionClaims, client: Pick<RequestDb, "user"> = db, admin = false) {
  const user = await client.user.findFirst({ where: { id: session.sub, active: true, sessionVersion: session.version, revokedSessions: { none: { id: session.jti } } }, select: { id: true, role: true } });
  if (!user || session.exp * 1000 <= Date.now()) throw new RequestError("Session is no longer active", 401);
  if (admin && user.role !== "admin") throw new RequestError("Admin role required", 403);
  return user;
}
export async function lockRequests(tx: RequestDb) {
  await tx.setting.upsert({ where: { key: "requests.mutation.lock" }, create: { key: "requests.mutation.lock", value: "1" }, update: { value: "1" } });
}
export function canonicalMediaKey(media: MetadataDetails) {
  return media.imdbId ? `imdb:${media.type}:${media.imdbId}` : `${media.provider}:${media.type}:${media.id}`;
}
function sameIdentity(media: MetadataDetails, other: MetadataDetails) {
  if (media.type !== other.type) return false;
  if (media.imdbId && other.imdbId) return media.imdbId === other.imdbId;
  if (media.tmdbId && other.tmdbId) return media.tmdbId === other.tmdbId;
  return media.provider === other.provider && media.id === other.id;
}
const normalize = (name: string) => name.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function sameLegacy(media: MetadataDetails, other: { name: string; type: string; year: number | null }) {
  return media.year !== null && media.year === other.year && media.type === other.type && normalize(media.name) === normalize(other.name);
}
export interface Availability { kind: "private" | "shared" | "catalog"; name: string; href: string }
/** Search metadata identities, never arbitrary names across other users' private storage. */
async function matchingMetadata(media: MetadataDetails, targetType: string, owners?: string[]) {
  if (owners && !owners.length) return [];
  const data = Prisma.sql`CASE WHEN json_valid(data) THEN data ELSE '{}' END`;
  const identity = Prisma.sql`(json_extract(${data}, '$.type') = ${media.type} AND (
    (json_extract(${data}, '$.provider') = ${media.provider} AND json_extract(${data}, '$.id') = ${media.id})
    ${media.imdbId ? Prisma.sql`OR json_extract(${data}, '$.imdbId') = ${media.imdbId}` : Prisma.empty}
    ${media.tmdbId ? Prisma.sql`OR json_extract(${data}, '$.tmdbId') = ${media.tmdbId}` : Prisma.empty}
  ))`;
  return db.$queryRaw<{ targetId: string; ownerId: string | null; data: string }[]>(Prisma.sql`SELECT targetId, ownerId, data FROM MetadataRecord WHERE targetType = ${targetType} AND ${identity} ${owners ? Prisma.sql`AND ownerId IN (${Prisma.join(owners)})` : Prisma.empty} LIMIT 500`);
}
export async function mediaAvailability(userId: string, media: MetadataDetails): Promise<Availability[]> {
  const libraries = await db.sharedLibrary.findMany({ where: visibleSharedLibraryWhere(userId), take: 100, orderBy: { createdAt: "asc" } });
  const matches = await matchingMetadata(media, "account", [...new Set([userId, ...libraries.map(library => library.sourceUserId)])]);
  const ids = matches.filter(row => { const parsed = storedMetadata(row.data); return parsed && sameIdentity(media, parsed); }).map(row => row.targetId);
  const candidates: Prisma.AccountMediaWhereInput = { phase: "finished", type: media.type, OR: [
    { id: { in: ids } }, ...(media.year === null ? [] : [{ name: { contains: media.name }, year: media.year }]),
  ] };
  const availability: Availability[] = [];
  const own = await db.accountMedia.findMany({ where: { AND: [await currentAccountMediaFilter(userId), candidates] }, take: 20 });
  const shared = await Promise.all(libraries.map(async library => ({ library, items: await db.accountMedia.findMany({ where: { AND: [await sharedMediaWhere(library), candidates] }, take: 10 }) })));
  const all = [...own, ...shared.flatMap(group => group.items)];
  const records = all.length ? await db.metadataRecord.findMany({ where: { targetType: "account", targetId: { in: all.map(item => item.id) } }, select: { targetId: true, ownerId: true, data: true } }) : [];
  const valid = (item: typeof own[number]) => {
    const row = records.find(record => record.targetId === item.id && record.ownerId === item.userId), metadata = row ? storedMetadata(row.data) : null;
    return metadata ? sameIdentity(media, metadata) : sameLegacy(media, item);
  };
  for (const item of own.filter(valid)) {
    if (await db.accountMedia.count({ where: { id: item.id, AND: [await currentAccountMediaFilter(userId)], phase: "finished" } })) availability.push({ kind: "private", name: item.name, href: `/library/${encodeURIComponent(item.id)}` });
    if (availability.length >= 5) break;
  }
  for (const { library, items } of shared) {
    for (const item of items.filter(valid)) {
      if (await db.sharedLibrary.findFirst({ where: { id: library.id, updatedAt: library.updatedAt, ...visibleSharedLibraryWhere(userId) }, select: { id: true } }) && await db.accountMedia.count({ where: { id: item.id, phase: "finished", AND: [await sharedMediaWhere(library)] } })) availability.push({ kind: "shared", name: library.name, href: `/shared-libraries/${encodeURIComponent(library.id)}/${encodeURIComponent(item.id)}` });
      if (availability.length >= 5) break;
    }
    if (availability.length >= 5) break;
  }

  return availability.slice(0, 5);
}
/** An approved source binding can identify an import even before metadata matching. */
export async function requestAvailability(request: MediaRequest, userId: string): Promise<Availability[]> {
  if (request.destination !== "cloud" || !request.sourceUserId || !request.providerId || !request.providerRef || !request.sourceFingerprint) return [];
  const source: Prisma.AccountMediaWhereInput = { userId: request.sourceUserId, provider: request.providerId, providerRef: request.providerRef, credentialFingerprint: request.sourceFingerprint, phase: "finished", type: request.mediaType };
  if (request.sharedLibraryId) {
    const library = await db.sharedLibrary.findFirst({ where: { id: request.sharedLibraryId, ...visibleSharedLibraryWhere(userId) } });
    if (library && library.sourceUserId === request.sourceUserId && ["all", request.mediaType].includes(library.mediaType)) {
      const item = await db.accountMedia.findFirst({ where: { AND: [source, await sharedMediaWhere(library)] }, select: { id: true } });
      const record = item ? await db.metadataRecord.findUnique({ where: { targetType_targetId: { targetType: "account", targetId: item.id } } }) : null;
      const matched = record?.ownerId === request.sourceUserId ? storedMetadata(record.data) : null, requested = storedMetadata(request.metadata);
      if (matched && requested && !sameIdentity(requested, matched)) return [];
      if (item && await db.sharedLibrary.findFirst({ where: { id: library.id, updatedAt: library.updatedAt, ...visibleSharedLibraryWhere(userId) }, select: { id: true } }) && await db.accountMedia.count({ where: { id: item.id, AND: [source, await sharedMediaWhere(library)] } })) return [{ kind: "shared", name: library.name, href: `/shared-libraries/${encodeURIComponent(library.id)}/${encodeURIComponent(item.id)}` }];
    }
  }
  if (userId === request.sourceUserId) {
    const item = await db.accountMedia.findFirst({ where: { AND: [source, await currentAccountMediaFilter(userId)] }, select: { id: true, name: true } });
    if (item) {
      const record = await db.metadataRecord.findUnique({ where: { targetType_targetId: { targetType: "account", targetId: item.id } } });
      const matched = record?.ownerId === userId ? storedMetadata(record.data) : null, requested = storedMetadata(request.metadata);
      if ((!matched || !requested || sameIdentity(requested, matched)) && await db.accountMedia.count({ where: { id: item.id, AND: [source, await currentAccountMediaFilter(userId)] } })) return [{ kind: "private", name: item.name, href: `/library/${encodeURIComponent(item.id)}` }];
    }
  }
  return [];
}
export async function requestView(request: MediaRequest, userId: string, admin = false) {
  const following = Boolean(await db.requestFollower.findUnique({ where: { requestId_userId: { requestId: request.id, userId } } }));
  const metadata = storedMetadata(request.metadata);
  const accessible = request.status !== "available" || admin || Boolean((await requestAvailability(request, userId)).length || metadata && (await mediaAvailability(userId, metadata)).length);
  return { id: request.id, provider: request.provider, externalId: request.externalId, type: request.mediaType,
    name: request.name, year: request.year, posterUrl: metadata?.posterUrl ?? null,
    status: accessible ? request.status : "downloaded", destination: request.destination,
    progress: request.progress, downloadState: accessible ? request.downloadState : "awaiting_library_access",
    error: request.error, createdAt: request.createdAt.toISOString(), updatedAt: request.updatedAt.toISOString(), following,
    ...(admin ? { providerId: request.providerId, sharedLibraryId: request.sharedLibraryId,
      subscribers: (await db.requestFollower.findMany({ where: { requestId: request.id }, take: 100, include: { user: { select: { id: true, email: true, displayName: true } } } })).map(follower => follower.user) } : {}),
  };
}
export async function requestEvents(requestId: string, awaitingAccess = false) {
  const events = await db.requestEvent.findMany({ where: { requestId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
  return events.reverse().map(({ id, status, message, progress, createdAt }) => ({ id, status: awaitingAccess && status === "available" ? "downloaded" : status, message: awaitingAccess && status === "available" ? "Download finished; this account still needs library access." : message, progress, createdAt: createdAt.toISOString() }));
}
