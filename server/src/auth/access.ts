import { createHash, randomBytes } from "node:crypto";
import { Invitation, Prisma } from "@prisma/client";
import { config } from "../config";
import { db } from "../db";
import { LIMIT_AGES } from "../ratings";

export type RegistrationMode = "open" | "invite" | "closed";
export const REGISTRATION_KEY = "auth.registration";
type AccessDb = Pick<Prisma.TransactionClient, "setting" | "user" | "invitation">;

export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * A server whose administrator never chose is invitation only: a private server stays private until its owner opens it, and nobody who
 * merely finds the address can create an account. The first account, which sets the server up, never needs an invitation.
 * Malformed settings fail closed.
 */
export const DEFAULT_REGISTRATION: RegistrationMode = "invite";
export async function registrationMode(client: AccessDb = db): Promise<RegistrationMode> {
  const row = await client.setting.findUnique({ where: { key: REGISTRATION_KEY } });
  if (!row) return DEFAULT_REGISTRATION;
  try {
    const mode: unknown = JSON.parse(row.value).mode;
    return mode === "open" || mode === "invite" || mode === "closed" ? mode : "closed";
  } catch { return "closed"; }
}

/**
 * Run once at start. A server that already has accounts and never saved a policy was open until this default existed. The choice is
 * written down so the administrator sees it in Admin → Users, and the returned sentence goes into the log so the change is not silent.
 */
export async function settleRegistrationDefault(client: AccessDb = db): Promise<string | null> {
  const [row, accounts] = await Promise.all([client.setting.findUnique({ where: { key: REGISTRATION_KEY } }), client.user.count()]);
  if (row || accounts === 0) return null;
  await client.setting.create({ data: { key: REGISTRATION_KEY, value: JSON.stringify({ mode: DEFAULT_REGISTRATION }) } });
  return "New accounts now need an invitation, because no registration choice had been saved on this server. Invite people from Admin → Users, or choose Open registration there.";
}

/** Share the signup write lock with policy updates and invitation issuance. */
export async function lockRegistration(tx: Prisma.TransactionClient): Promise<void> {
  await tx.setting.upsert({ where: { key: "auth.signup.lock" }, create: { key: "auth.signup.lock", value: "1" }, update: { value: "1" } });
}

/** Retry a rolled-back signup when another SQLite writer temporarily holds the database. */
export async function registrationTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(operation, { maxWait: 10000, timeout: 10000 });
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || !["P1008", "P2034"].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export function invitationHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function usable(invitation: Invitation | null, now: Date): invitation is Invitation {
  return Boolean(invitation && !invitation.acceptedAt && !invitation.revokedAt && invitation.expiresAt > now);
}

export async function inspectInvitation(token: string, client: AccessDb = db): Promise<Invitation> {
  const invitation = /^[A-Za-z0-9_-]{43}$/.test(token)
    ? await client.invitation.findUnique({ where: { tokenHash: invitationHash(token) } }) : null;
  if (!usable(invitation, new Date())) throw new AccessError(400, "This invitation is invalid, expired or no longer available");
  return invitation;
}

/** Rechecked under a SQLite write lock immediately before creating the user. Returns the invitation it consumed, if any. */
export async function checkSignupAccess(email: string, token: string | undefined, client: AccessDb = db, consume = false): Promise<Invitation | null> {
  const count = await client.user.count();
  const bootstrap = count === 0 && (!config.adminEmail || email === config.adminEmail.toLowerCase());
  const mode = await registrationMode(client);
  if (bootstrap && !token) return null;
  if (mode === "closed") throw new AccessError(403, "New account registration is closed");
  if (!token) {
    if (mode === "invite") throw new AccessError(403, "An invitation is required to create an account");
    return null;
  }
  const invitation = await inspectInvitation(token, client);
  if (invitation.email !== email) throw new AccessError(400, "Use the email address assigned to this invitation");
  if (consume) {
    const used = await client.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (used.count !== 1) throw new AccessError(400, "This invitation is invalid, expired or no longer available");
  }
  return invitation;
}

export const invitationLibraryIds = (invitation: Pick<Invitation, "libraryIds">): string[] => {
  try { const ids = JSON.parse(invitation.libraryIds); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
};
/** Gives a new account what its invitation promised: the listed libraries (that still exist) and the viewing limit. */
export async function applyInvitationAccess(tx: Prisma.TransactionClient, userId: string, invitation: Invitation | null): Promise<void> {
  if (!invitation) return;
  const libraries = await tx.sharedLibrary.findMany({ where: { id: { in: invitationLibraryIds(invitation) } }, select: { id: true } });
  if (libraries.length) await tx.sharedLibraryGrant.createMany({ data: libraries.map(library => ({ libraryId: library.id, userId })) });
  if (invitation.maxAge !== null && LIMIT_AGES.includes(invitation.maxAge)) await tx.user.update({ where: { id: userId }, data: { maxAge: invitation.maxAge } });
}
/** What the invited person is told before they sign up: the names of the libraries they will get. */
export async function invitationPreview(invitation: Invitation) {
  const libraries = await db.sharedLibrary.findMany({ where: { id: { in: invitationLibraryIds(invitation) }, enabled: true }, select: { name: true }, orderBy: { name: "asc" }, take: 20 });
  return { libraries: libraries.map(library => library.name), limited: invitation.maxAge !== null };
}

export function publicInvitation(invitation: Invitation) {
  const { id, email, createdAt, expiresAt, acceptedAt, revokedAt, maxAge } = invitation;
  const status = acceptedAt ? "accepted" : revokedAt ? "revoked" : expiresAt <= new Date() ? "expired" : "pending";
  return { id, email, createdAt, expiresAt, acceptedAt, revokedAt, status, libraryIds: invitationLibraryIds(invitation), maxAge };
}

export interface InvitationAccess { libraryIds: string[]; maxAge: number | null }
export async function createInvitation(email: string, createdById: string, expiresInDays: number, access: InvitationAccess = { libraryIds: [], maxAge: null }) {
  const inviteToken = randomBytes(32).toString("base64url");
  const invitation = await db.$transaction(async tx => {
    await lockRegistration(tx);
    if (await registrationMode(tx) === "closed") throw new AccessError(409, "Enable invitation or open registration before creating an invitation");
    if (await tx.user.findUnique({ where: { email } })) throw new AccessError(409, "This email already has an account; ask the user to sign in");
    // Issuing a replacement invalidates older unaccepted links for this address.
    await tx.invitation.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    // An administrator can only hand out libraries they manage, and only the offered viewing limits.
    const libraryIds = [...new Set(access.libraryIds)];
    if (libraryIds.length && await tx.sharedLibrary.count({ where: { id: { in: libraryIds }, sourceUserId: createdById } }) !== libraryIds.length) throw new AccessError(400, "Choose libraries that you manage");
    if (access.maxAge !== null && !LIMIT_AGES.includes(access.maxAge)) throw new AccessError(400, "Choose one of the offered viewing limits");
    return tx.invitation.create({ data: { email, createdById, tokenHash: invitationHash(inviteToken), expiresAt: new Date(Date.now() + expiresInDays * 86400000), libraryIds: JSON.stringify(libraryIds), maxAge: access.maxAge } });
  }, { maxWait: 10000, timeout: 10000 });
  return { invitation: publicInvitation(invitation), inviteToken };
}
