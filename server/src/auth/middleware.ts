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
  // Cookie fallback so the Next.js web client can authenticate without JS headers.
  const cookie = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("sr_token="));
  return cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : null;
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
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const user = await db.user.findUnique({ where: { id: req.session.sub } });
  if (!user || !user.active) {
    res.status(401).json({ error: "Account is not active" });
    return;
  }
  // Role changes take effect immediately, not at token refresh.
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
