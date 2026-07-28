import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { db } from "../db";
import { PROVIDER_IDS } from "../providers/types";
import { parseBody, publicUser } from "./helpers";

export const accountRouter = Router();
accountRouter.use(requireAuth);

accountRouter.get("/profile", async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.session!.sub },
    include: { profiles: true },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const { profiles, ...rest } = user;
  res.json({ user: publicUser(rest), profiles });
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

accountRouter.put("/update", async (req, res) => {
  const body = parseBody(updateSchema, req.body, res);
  if (!body) return;
  const user = await db.user.update({
    where: { id: req.session!.sub },
    data: body,
  });
  res.json({ user: publicUser(user) });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

accountRouter.post("/change-password", async (req, res) => {
  const body = parseBody(passwordSchema, req.body, res);
  if (!body) return;
  const user = await db.user.findUnique({ where: { id: req.session!.sub } });
  if (!user || !(await verifyPassword(body.currentPassword, user.hashedPassword))) {
    res.status(403).json({ error: "Current password is incorrect" });
    return;
  }
  await db.user.update({
    where: { id: user.id },
    data: { hashedPassword: await hashPassword(body.newPassword) },
  });
  res.json({ ok: true });
});

const MAX_PROFILES_PER_USER = 5;

/** GET /api/account/profiles — list this user's viewing profiles. */
accountRouter.get("/profiles", async (req, res) => {
  const profiles = await db.profile.findMany({
    where: { userId: req.session!.sub },
    orderBy: { createdAt: "asc" },
  });
  res.json({ profiles });
});

const profileSchema = z.object({
  name: z.string().min(1).max(40),
  avatarUrl: z.string().url().nullable().optional(),
});

/** POST /api/account/profiles — add a profile (e.g. "Kids"), capped per account. */
accountRouter.post("/profiles", async (req, res) => {
  const body = parseBody(profileSchema, req.body, res);
  if (!body) return;
  const count = await db.profile.count({ where: { userId: req.session!.sub } });
  if (count >= MAX_PROFILES_PER_USER) {
    res.status(409).json({ error: `You can have at most ${MAX_PROFILES_PER_USER} profiles` });
    return;
  }
  const profile = await db.profile.create({
    data: { userId: req.session!.sub, name: body.name, avatarUrl: body.avatarUrl ?? null },
  });
  res.status(201).json({ profile });
});

const profileUpdateSchema = profileSchema.partial();

accountRouter.patch("/profiles/:id", async (req, res) => {
  const body = parseBody(profileUpdateSchema, req.body, res);
  if (!body) return;
  const existing = await db.profile.findFirst({
    where: { id: req.params.id, userId: req.session!.sub },
  });
  if (!existing) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  const profile = await db.profile.update({ where: { id: existing.id }, data: body });
  res.json({ profile });
});

accountRouter.delete("/profiles/:id", async (req, res) => {
  const existing = await db.profile.findFirst({
    where: { id: req.params.id, userId: req.session!.sub },
  });
  if (!existing) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  await db.profile.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

/** Redact stored keys down to a hint the UI can display. */
function keyHint(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

accountRouter.get("/debrid", async (req, res) => {
  const cfg = await db.debridConfig.upsert({
    where: { userId: req.session!.sub },
    create: { userId: req.session!.sub },
    update: {},
  });
  res.json({
    primaryProvider: cfg.primaryProvider,
    fallbackOrder: JSON.parse(cfg.fallbackOrder),
    keys: {
      realdebrid: keyHint(cfg.realDebridToken),
      alldebrid: keyHint(cfg.allDebridApiKey),
      premiumize: keyHint(cfg.premiumizeApiKey),
    },
  });
});

const debridSchema = z.object({
  primaryProvider: z.enum(PROVIDER_IDS).optional(),
  fallbackOrder: z.array(z.enum(PROVIDER_IDS)).optional(),
  // null clears a stored key; undefined leaves it untouched.
  realDebridToken: z.string().nullable().optional(),
  allDebridApiKey: z.string().nullable().optional(),
  premiumizeApiKey: z.string().nullable().optional(),
});

accountRouter.put("/debrid", async (req, res) => {
  const body = parseBody(debridSchema, req.body, res);
  if (!body) return;
  const data: Record<string, unknown> = {};
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
  res.json({ ok: true });
});
