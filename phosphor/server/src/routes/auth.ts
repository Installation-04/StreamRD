import { Prisma } from "@prisma/client";
import { asyncHandler } from "../http";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { signSession } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { logEvent } from "../logger";
import { rateLimit } from "../util/rateLimit";
import { parseBody, publicUser } from "./helpers";

export const authRouter = Router();

// Generous enough for a household signing up several accounts, tight enough
// to blunt a scripted brute-force loop against a single self-hosted server.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many attempts, please try again later",
});

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().min(1).max(80),
});

authRouter.post("/signup", authRateLimit, asyncHandler(async (req, res) => {
  const body = parseBody(signupSchema, req.body, res);
  if (!body) return;
  const email = body.email.toLowerCase();
  if (await db.user.findUnique({ where: { email } })) { res.status(409).json({ error: "An account with this email already exists" }); return; }
  // Hash outside the transaction so bcrypt does not hold the SQLite write lock.
  const hashedPassword = await hashPassword(body.password);
  const user = await db.$transaction(async tx => {
    // Take a write lock before reading the count, across processes as well as requests.
    await tx.setting.upsert({ where: { key: "auth.signup.lock" }, create: { key: "auth.signup.lock", value: "1" }, update: { value: "1" } });
    const count = await tx.user.count();
    const role = config.adminEmail ? (email === config.adminEmail.toLowerCase() ? "admin" : "user") : count === 0 ? "admin" : "user";
    return tx.user.create({ data: { email, displayName: body.displayName, hashedPassword, role, debridConfig: { create: {} } } });
  }, { maxWait: 10000, timeout: 10000 });
  await logEvent("info", "signup", `New account ${email} (${user.role})`, { userId: user.id });
  const token = signSession({ sub: user.id, email: user.email, role: user.role === "admin" ? "admin" : "user",
    version: user.sessionVersion });
  res.status(201).json({ token, user: publicUser(user) });
}));

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", authRateLimit, asyncHandler(async (req, res) => {
  const body = parseBody(loginSchema, req.body, res);
  if (!body) return;
  const user = await db.user.findUnique({ where: { email: body.email.toLowerCase() } });
  if (!user || !(await verifyPassword(body.password, user.hashedPassword))) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  if (!user.active) {
    res.status(403).json({ error: "This account has been deactivated" });
    return;
  }
  await logEvent("info", "login", `Login ${user.email}`, { userId: user.id });
  const token = signSession({ sub: user.id, email: user.email, role: user.role === "admin" ? "admin" : "user", version: user.sessionVersion });
  res.json({ token, user: publicUser(user) });
}));

authRouter.post("/logout", asyncHandler(async (req, res) => {
  if (req.session) {
    try {
      await db.revokedSession.upsert({ where: { id: req.session.jti }, create: { id: req.session.jti, userId: req.session.sub, expiresAt: new Date(req.session.exp * 1000) }, update: {} });
    } catch (err) {
      // A deleted account is already unable to use this token.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && ["P2003", "P2025"].includes(err.code))) throw err;
    }
    await logEvent("info", "logout", "Session signed out", { userId: req.session.sub });
  }
  res.json({ ok: true });
}));
