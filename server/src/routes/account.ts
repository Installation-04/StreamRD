import { syncAccountLibraryConfiguration } from "../account-library";
import { signSession } from "../auth/jwt";
import { issueSession } from "../auth/cookie";
import { asyncHandler } from "../http";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { db } from "../db";
import { PROVIDER_IDS } from "../providers/types";
import { parseBody, publicUser } from "./helpers";

export const accountRouter = Router();
accountRouter.use(requireAuth);

accountRouter.get("/profile", asyncHandler(async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.session!.sub } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user: publicUser(user) });
}));

const updateSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

accountRouter.put("/update", asyncHandler(async (req, res) => {
  const body = parseBody(updateSchema, req.body, res);
  if (!body) return;
  const user = await db.user.update({
    where: { id: req.session!.sub },
    data: body,
  });
  res.json({ user: publicUser(user) });
}));

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

accountRouter.post("/change-password", asyncHandler(async (req, res) => {
  const body = parseBody(passwordSchema, req.body, res);
  if (!body) return;
  const user = await db.user.findUnique({ where: { id: req.session!.sub } });
  if (!user || !(await verifyPassword(body.currentPassword, user.hashedPassword))) {
    res.status(403).json({ error: "Current password is incorrect" });
    return;
  }
  const hashedPassword = await hashPassword(body.newPassword);
  const changed = await db.user.updateMany({ where: { id: user.id, hashedPassword: user.hashedPassword, sessionVersion: user.sessionVersion }, data: { hashedPassword, sessionVersion: { increment: 1 } } });
  if (!changed.count) { res.status(409).json({ error: "Account changed; sign in and try again" }); return; }
  const token = signSession({ sub: user.id, email: user.email, role: user.role === "admin" ? "admin" : "user", version: user.sessionVersion + 1 });
  res.json({ ok: true, ...issueSession(req, res, token), role: user.role === "admin" ? "admin" : "user" });
}));

/** Redact stored keys down to a hint the UI can display. */
function keyHint(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

accountRouter.get("/debrid", asyncHandler(async (req, res) => {
  const cfg = await db.debridConfig.upsert({
    where: { userId: req.session!.sub },
    create: { userId: req.session!.sub },
    update: {},
  });
  res.json({
    primaryProvider: cfg.primaryProvider,
    autoImportLibrary: cfg.autoImportLibrary,
    fallbackOrder: JSON.parse(cfg.fallbackOrder),
    keys: {
      realdebrid: keyHint(cfg.realDebridToken),
      alldebrid: keyHint(cfg.allDebridApiKey),
      premiumize: keyHint(cfg.premiumizeApiKey),
    },
  });
}));

const debridSchema = z.object({
  autoImportLibrary: z.boolean().optional(),
  primaryProvider: z.enum(PROVIDER_IDS).optional(),
  fallbackOrder: z.array(z.enum(PROVIDER_IDS)).optional(),
  // null clears a stored key; undefined leaves it untouched.
  realDebridToken: z.string().nullable().optional(),
  allDebridApiKey: z.string().nullable().optional(),
  premiumizeApiKey: z.string().nullable().optional(),
});

accountRouter.put("/debrid", asyncHandler(async (req, res) => {
  const body = parseBody(debridSchema, req.body, res);
  if (!body) return;
  const data: Record<string, unknown> = {};
  if (body.autoImportLibrary !== undefined) data.autoImportLibrary = body.autoImportLibrary;
  if (body.primaryProvider !== undefined) data.primaryProvider = body.primaryProvider;
  if (body.fallbackOrder !== undefined)
    data.fallbackOrder = JSON.stringify(body.fallbackOrder);
  for (const key of ["realDebridToken", "allDebridApiKey", "premiumizeApiKey"] as const) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  await db.debridConfig.upsert({
    where: { userId: req.session!.sub },
    create: { userId: req.session!.sub, ...data },
    update: data,
  });
  await syncAccountLibraryConfiguration(req.session!.sub);
  res.json({ ok: true });
}));
