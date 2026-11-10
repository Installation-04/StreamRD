import { Router, Request, Response } from "express";
import { z } from "zod";
import { LIMIT_AGES } from "../ratings";
import { AccessError, createInvitation, lockRegistration, publicInvitation, registrationMode, REGISTRATION_KEY } from "../auth/access";
import { db } from "../db";
import { asyncHandler } from "../http";
import { logEvent } from "../logger";
import { rateLimit } from "../util/rateLimit";
import { parseBody } from "./helpers";

/** Mounted only behind requireAuth + requireAdmin in admin.ts. */
export const accessRouter = Router();
accessRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
const mutationLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const action = (run: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(async (req, res) => {
  try { await run(req, res); }
  catch (error) { if (error instanceof AccessError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
});

accessRouter.get("/access", action(async (_req, res) => { res.json({ mode: await registrationMode() }); }));
accessRouter.put("/access", mutationLimit, action(async (req, res) => {
  const body = parseBody(z.object({ mode: z.enum(["open", "invite", "closed"]) }), req.body, res);
  if (!body) return;
  await db.$transaction(async tx => {
    await lockRegistration(tx);
    await tx.setting.upsert({ where: { key: REGISTRATION_KEY }, create: { key: REGISTRATION_KEY, value: JSON.stringify(body) }, update: { value: JSON.stringify(body) } });
  }, { maxWait: 10000, timeout: 10000 });
  await logEvent("info", "admin_action", "Updated account registration policy", { userId: req.session!.sub, meta: { mode: body.mode } });
  res.json(body);
}));

accessRouter.get("/invitations", action(async (_req, res) => {
  const invitations = await db.invitation.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
  res.json({ invitations: invitations.map(publicInvitation) });
}));
accessRouter.post("/invitations", mutationLimit, action(async (req, res) => {
  const body = parseBody(z.object({
    email: z.string().trim().email().max(254), expiresInDays: z.number().int().min(1).max(30).default(7),
    // What the new account gets when it is created: these libraries and this viewing limit (7, 8, 14, 17 or none).
    libraryIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(20).default([]),
    maxAge: z.number().int().refine(age => LIMIT_AGES.includes(age)).nullable().default(null),
  }), req.body, res);
  if (!body) return;
  const result = await createInvitation(body.email.toLowerCase(), req.session!.sub, body.expiresInDays, { libraryIds: body.libraryIds, maxAge: body.maxAge });
  await logEvent("info", "admin_action", "Created an account invitation", { userId: req.session!.sub, meta: { invitationId: result.invitation.id, libraries: body.libraryIds.length, limited: body.maxAge !== null } });
  res.status(201).json(result);
}));
/** The address put in invitation links: how invited people reach this server (a LAN address, a Tailscale name, a domain). */
const INVITE_ADDRESS_KEY = "server.inviteAddress";
accessRouter.get("/invite-address", action(async (_req, res) => {
  const row = await db.setting.findUnique({ where: { key: INVITE_ADDRESS_KEY } });
  res.json({ url: row?.value || null });
}));
accessRouter.put("/invite-address", mutationLimit, action(async (req, res) => {
  const body = parseBody(z.object({ url: z.string().trim().max(200).nullable() }), req.body, res);
  if (!body) return;
  let url: string | null = null;
  if (body.url) {
    try {
      const parsed = new URL(body.url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) throw new Error("shape");
      url = parsed.origin;
    } catch { throw new AccessError(400, "Enter an address such as http://192.168.1.20:8080 or https://media.example.com (no path)"); }
  }
  if (url) await db.setting.upsert({ where: { key: INVITE_ADDRESS_KEY }, create: { key: INVITE_ADDRESS_KEY, value: url }, update: { value: url } });
  else await db.setting.deleteMany({ where: { key: INVITE_ADDRESS_KEY } });
  await logEvent("info", "admin_action", "Updated the address used in invitation links", { userId: req.session!.sub });
  res.json({ url });
}));
accessRouter.post("/invitations/:id/revoke", mutationLimit, action(async (req, res) => {
  const invitation = await db.$transaction(async tx => {
    await lockRegistration(tx);
    const existing = await tx.invitation.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AccessError(404, "Invitation not found");
    if (existing.acceptedAt) throw new AccessError(409, "This invitation was already accepted; manage the account instead");
    return existing.revokedAt ? existing : tx.invitation.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  }, { maxWait: 10000, timeout: 10000 });
  await logEvent("info", "admin_action", "Revoked an account invitation", { userId: req.session!.sub, meta: { invitationId: invitation.id } });
  res.json({ invitation: publicInvitation(invitation) });
}));

accessRouter.post("/users/:id/revoke-sessions", mutationLimit, action(async (req, res) => {
  if (req.params.id === req.session!.sub) throw new AccessError(400, "Change your password to replace your own sessions");
  const result = await db.user.updateMany({ where: { id: req.params.id }, data: { sessionVersion: { increment: 1 } } });
  if (!result.count) throw new AccessError(404, "User not found");
  await logEvent("info", "admin_action", "Signed an account out of all sessions", { userId: req.session!.sub, meta: { targetUserId: req.params.id } });
  res.json({ ok: true });
}));
