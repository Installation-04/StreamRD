import { createHash, randomBytes } from "node:crypto";
import { Invitation, Prisma } from "@prisma/client";
import { config } from "../config";
import { db } from "../db";

export type RegistrationMode = "open" | "invite" | "closed";
export const REGISTRATION_KEY = "auth.registration";
type AccessDb = Pick<Prisma.TransactionClient, "setting" | "user" | "invitation">;

export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Missing settings preserve existing installations; malformed settings fail closed. */
export async function registrationMode(client: AccessDb = db): Promise<RegistrationMode> {
  const row = await client.setting.findUnique({ where: { key: REGISTRATION_KEY } });
  if (!row) return "open";
  try {
    const mode: unknown = JSON.parse(row.value).mode;
    return mode === "open" || mode === "invite" || mode === "closed" ? mode : "closed";
  } catch { return "closed"; }
}

/** Share the signup write lock with policy updates and invitation issuance. */
export async function lockRegistration(tx: Prisma.TransactionClient): Promise<void> {
  await tx.setting.upsert({ where: { key: "auth.signup.lock" }, create: { key: "auth.signup.lock", value: "1" }, update: { value: "1" } });
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

/** Rechecked under a SQLite write lock immediately before creating the user. */
export async function checkSignupAccess(email: string, token: string | undefined, client: AccessDb = db, consume = false): Promise<void> {
  const count = await client.user.count();
  const bootstrap = count === 0 && (!config.adminEmail || email === config.adminEmail.toLowerCase());
  const mode = await registrationMode(client);
  if (bootstrap && !token) return;
  if (mode === "closed") throw new AccessError(403, "New account registration is closed");
  if (!token) {
    if (mode === "invite") throw new AccessError(403, "An invitation is required to create an account");
    return;
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
}

export function publicInvitation(invitation: Invitation) {
  const { id, email, createdAt, expiresAt, acceptedAt, revokedAt } = invitation;
  const status = acceptedAt ? "accepted" : revokedAt ? "revoked" : expiresAt <= new Date() ? "expired" : "pending";
  return { id, email, createdAt, expiresAt, acceptedAt, revokedAt, status };
}

export async function createInvitation(email: string, createdById: string, expiresInDays: number) {
  const inviteToken = randomBytes(32).toString("base64url");
  const invitation = await db.$transaction(async tx => {
    await lockRegistration(tx);
    if (await registrationMode(tx) === "closed") throw new AccessError(409, "Enable invitation or open registration before creating an invitation");
    if (await tx.user.findUnique({ where: { email } })) throw new AccessError(409, "This email already has an account; ask the user to sign in");
    // Issuing a replacement invalidates older unaccepted links for this address.
    await tx.invitation.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    return tx.invitation.create({ data: { email, createdById, tokenHash: invitationHash(inviteToken), expiresAt: new Date(Date.now() + expiresInDays * 86400000) } });
  }, { maxWait: 10000, timeout: 10000 });
  return { invitation: publicInvitation(invitation), inviteToken };
}
