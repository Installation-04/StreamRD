import { syncAccountLibraryConfiguration } from "../account-library";
import { signSession } from "../auth/jwt";
import { asyncHandler } from "../http";
import { accountListsRouter, historyPage } from "./accountLists";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { db } from "../db";
import { PROVIDER_IDS } from "../providers/types";
import { parseBody, publicTitle, publicUser } from "./helpers";

export const accountRouter = Router();
accountRouter.use(requireAuth);
accountRouter.use(accountListsRouter);

accountRouter.get("/profile", asyncHandler(async (req, res) => {
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
  res.json({ ok: true, token, role: user.role === "admin" ? "admin" : "user" });
}));

const MAX_PROFILES_PER_USER = 5;

/** GET /api/account/profiles — list this user's viewing profiles. */
accountRouter.get("/profiles", asyncHandler(async (req, res) => {
  const profiles = await db.profile.findMany({
    where: { userId: req.session!.sub },
    orderBy: { createdAt: "asc" },
  });
  res.json({ profiles });
}));

const profileSchema = z.object({
  name: z.string().min(1).max(40),
  avatarUrl: z.string().url().nullable().optional(),
});

/** POST /api/account/profiles — add a profile (e.g. "Kids"), capped per account. */
accountRouter.post("/profiles", asyncHandler(async (req, res) => {
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
}));

const profileUpdateSchema = profileSchema.partial();

accountRouter.patch("/profiles/:id", asyncHandler(async (req, res) => {
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
}));

accountRouter.delete("/profiles/:id", asyncHandler(async (req, res) => {
  const existing = await db.profile.findFirst({
    where: { id: req.params.id, userId: req.session!.sub },
  });
  if (!existing) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  await db.profile.delete({ where: { id: existing.id } });
  res.json({ ok: true });
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

/** GET /api/account/favorites — "My List", most recently added first. */
accountRouter.get("/favorites", asyncHandler(async (req, res) => {
  const favorites = await db.favorite.findMany({
    where: { userId: req.session!.sub },
    include: { title: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ titles: favorites.map((f) => publicTitle(f.title)) });
}));

/** POST /api/account/favorites/:titleId — idempotent add to "My List". */
accountRouter.post("/favorites/:titleId", asyncHandler(async (req, res) => {
  const title = await db.title.findUnique({ where: { id: req.params.titleId } });
  if (!title) {
    res.status(404).json({ error: "Title not found" });
    return;
  }
  await db.favorite.upsert({
    where: { userId_titleId: { userId: req.session!.sub, titleId: title.id } },
    create: { userId: req.session!.sub, titleId: title.id },
    update: {},
  });
  res.status(201).json({ ok: true });
}));

accountRouter.delete("/favorites/:titleId", asyncHandler(async (req, res) => {
  await db.favorite.deleteMany({
    where: { userId: req.session!.sub, titleId: req.params.titleId },
  });
  res.json({ ok: true });
}));

const CONTINUE_WATCHING_LIMIT = 20;

/**
 * GET /api/account/continue-watching — titles this user has successfully
 * played before, most recent first, deduped so each title appears once.
 */
accountRouter.get("/continue-watching", asyncHandler(async (req, res) => {
  const history = await historyPage(req.session!.sub, CONTINUE_WATCHING_LIMIT);
  const orderedIds = history.map(row => row.titleId);
  const titles = await db.title.findMany({ where: { id: { in: orderedIds } } });
  const byId = new Map(titles.map((title) => [title.id, title]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((t): t is (typeof titles)[number] => !!t);
  res.json({ titles: ordered.map((title) => publicTitle(title)) });
}));
