import { NextFunction, Request, Response } from "express";
import { db } from "../db";
import { SessionClaims, verifySession } from "./jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionClaims;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const cookie = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("ph_token="));
  try { return cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : null; } catch { return null; }
}

/** Populates req.session when a valid token is present; never rejects. */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    const claims = verifySession(token);
    if (claims) req.session = claims;
  }
  next();
}

/** Rejects unauthenticated requests, and requests from deactivated accounts. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  let user;
  try {
    user = await db.user.findFirst({ where: { id: req.session.sub, active: true, sessionVersion: req.session.version, revokedSessions: { none: { id: req.session.jti } } }, select: { role: true, email: true } });
  } catch (err) { next(err); return; }
  if (!user) {
    res.status(401).json({ error: "Session is no longer active" });
    return;
  }
  req.session.email = user.email;
  req.session.role = user.role === "admin" ? "admin" : "user";
  next();
}

/** Rejects any caller whose account is not an admin. Use after requireAuth. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.role !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  next();
}
