import { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { db } from "../db";
import { SESSION_COOKIE } from "./cookie";
import { SessionClaims, verifySession } from "./jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionClaims;
      sessionSource?: "bearer" | "cookie";
    }
  }
}

function extractToken(req: Request): { token: string; source: "bearer" | "cookie" } | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice(7), source: "bearer" };
  // Browser sessions travel as an HttpOnly cookie (see cookie.ts); older web clients wrote this cookie themselves.
  const cookie = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  try { return cookie ? { token: decodeURIComponent(cookie.split("=").slice(1).join("=")), source: "cookie" } : null; } catch { return null; }
}

/** Populates req.session when a valid token is present; never rejects. */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const found = extractToken(req);
  if (found) {
    const claims = verifySession(found.token);
    if (claims) { req.session = claims; req.sessionSource = found.source; }
  }
  next();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function sameOrigin(origin: string, req: Request): boolean {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  const hosts = [req.headers.host];
  if (process.env.TRUST_PROXY === "true") hosts.push(String(req.headers["x-forwarded-host"] ?? ""));
  // Normalize through URL so an explicit default port (":80", ":443") compares equal to the bare host.
  return hosts.some((candidate) => { if (!candidate) return false; try { return new URL(`${parsed.protocol}//${candidate}`).host === parsed.host; } catch { return false; } });
}
/**
 * A browser attaches cookies by itself, so a cookie-authenticated change must come from our own pages:
 * never cross-site, and from this origin or an origin the operator allowed. Bearer requests are
 * unaffected (a script has to hold the token to send one).
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.sessionSource !== "cookie" || SAFE_METHODS.has(req.method)) { next(); return; }
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  const open = config.corsOrigins === "*"; // legacy setups: other ports on the same host call the API
  const listed = !open && !!origin && config.corsOrigins.split(",").map((value) => value.trim()).includes(origin);
  const allowed = site === "cross-site" ? false : !origin ? true : sameOrigin(origin, req) || listed || (open && site === "same-site");
  if (allowed) { next(); return; }
  res.status(403).json({ error: "Cross-site request blocked" });
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
  let user;
  try {
    user = await db.user.findFirst({ where: { id: req.session.sub, active: true, sessionVersion: req.session.version, revokedSessions: { none: { id: req.session.jti } } }, select: { role: true, email: true } });
  } catch (err) { next(err); return; }
  if (!user) {
    res.status(401).json({ error: "Session is no longer active" });
    return;
  }
  // Role changes take effect immediately, not at token refresh.
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
