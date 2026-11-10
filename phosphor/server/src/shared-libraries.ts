import { Prisma, SharedLibrary } from "@prisma/client";
import { db } from "./db";
import { AccountLibraryError, currentAccountMediaFilter } from "./account-library";
import { SessionClaims } from "./auth/jwt";

/** An explicit named view; a private account never becomes globally browsable. */
export function visibleSharedLibraryWhere(userId: string): Prisma.SharedLibraryWhereInput {
  return {
    enabled: true,
    sourceUser: { active: true, role: "admin" },
    OR: [{ sourceUserId: userId }, { everyone: true }, { grants: { some: { userId } } }],
  };
}
export function libraryMediaWhere(library: Pick<SharedLibrary, "sourceUserId" | "mediaType">): Prisma.AccountMediaWhereInput {
  return { userId: library.sourceUserId, ...(library.mediaType === "all" ? {} : { type: library.mediaType }) };
}
/** Local configuration only; never resolves or tests an upstream connection. */
export async function sharedMediaWhere(library: Pick<SharedLibrary, "sourceUserId" | "mediaType">) {
  return { AND: [libraryMediaWhere(library), await currentAccountMediaFilter(library.sourceUserId)] } satisfies Prisma.AccountMediaWhereInput;
}
export async function visibleSharedLibrary(userId: string, libraryId: string) {
  const library = await db.sharedLibrary.findFirst({ where: { id: libraryId, ...visibleSharedLibraryWhere(userId) } });
  if (!library) throw new AccountLibraryError("Shared library not found.", 404);
  return library;
}
/** Recheck both sharing and the exact viewer session after provider work. */
export async function assertActiveSharedViewer(session: SessionClaims) {
  if (session.exp * 1000 <= Date.now()) throw new AccountLibraryError("Session is no longer active.", 401);
  const viewer = await db.user.findFirst({ where: { id: session.sub, active: true, sessionVersion: session.version, revokedSessions: { none: { id: session.jti } } }, select: { id: true } });
  if (!viewer) throw new AccountLibraryError("Session is no longer active.", 401);
}
export async function assertSharedViewer(session: SessionClaims, libraryId: string) {
  await assertActiveSharedViewer(session);
  return visibleSharedLibrary(session.sub, libraryId);
}
export async function assertUnchangedSharedViewer(session: SessionClaims, library: SharedLibrary) {
  const fresh = await assertSharedViewer(session, library.id);
  if (fresh.updatedAt.getTime() !== library.updatedAt.getTime()) throw new AccountLibraryError("Shared library changed. Refresh and try again.", 409);
}
export async function sharedLibraryView(library: SharedLibrary) {
  return { id: library.id, name: library.name, mediaType: library.mediaType, itemCount: await db.accountMedia.count({ where: await sharedMediaWhere(library) }) };
}
/** Setup readiness uses only accessible, ready imports with current source bindings. */
export async function getSharedSetupState(userId: string): Promise<{ libraryCount: number; readyCount: number }> {
  if (!await db.user.findFirst({ where: { id: userId, active: true }, select: { id: true } })) return { libraryCount: 0, readyCount: 0 };
  const libraries = await db.sharedLibrary.findMany({ where: visibleSharedLibraryWhere(userId), take: 100, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (!libraries.length) return { libraryCount: 0, readyCount: 0 };
  // OR ensures an item shared through overlapping libraries is counted only once.
  const filters = await Promise.all(libraries.map(sharedMediaWhere));
  return { libraryCount: libraries.length, readyCount: await db.accountMedia.count({ where: { phase: "finished", OR: filters } }) };
}
