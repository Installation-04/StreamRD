import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { signSession } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { logEvent } from "../logger";
import { parseBody, publicUser } from "./helpers";

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().min(1).max(80),
});

authRouter.post("/signup", async (req, res) => {
  const body = parseBody(signupSchema, req.body, res);
  if (!body) return;
  const email = body.email.toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }
  const userCount = await db.user.count();
  const role =
    userCount === 0 || (config.adminEmail && email === config.adminEmail.toLowerCase()) ? "admin" : "user";
  const user = await db.user.create({
    data: {
      email,
      displayName: body.displayName,
      hashedPassword: await hashPassword(body.password),
      role,
      debridConfig: { create: {} },
    },
  });
  await logEvent("info", "signup", `New account ${email} (${role})`, { userId: user.id });
  const token = signSession({ sub: user.id, email: user.email, role: role as "user" | "admin" });
  res.status(201).json({ token, user: publicUser(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
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
  const token = signSession({ sub: user.id, email: user.email, role: user.role === "admin" ? "admin" : "user" });
  res.json({ token, user: publicUser(user) });
});

authRouter.post("/logout", async (req, res) => {
  if (req.session) {
    await logEvent("info", "logout", `Logout ${req.session.email}`, { userId: req.session.sub });
  }
  res.json({ ok: true });
});
