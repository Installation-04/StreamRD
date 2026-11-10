import { Request, Response } from "express";
import { PRODUCT } from "../product";
import { verifySession } from "./jwt";

/**
 * Browser sessions: when the web app and the API share an origin (the single container), the web app
 * asks for a cookie session with "X-Session: cookie". The token then lives only in an HttpOnly cookie, so
 * page scripts can never read it, and the response body omits it. Other clients (scripts, split
 * installs that use another origin) keep receiving the token in the body and sending it as a Bearer header.
 */
export const SESSION_COOKIE = PRODUCT.sessionCookie;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const wantsCookieSession = (req: Request): boolean => req.get("x-session") === "cookie";
function secure(req: Request): boolean {
  return req.secure || (process.env.TRUST_PROXY === "true" && req.get("x-forwarded-proto") === "https");
}
export function setSessionCookie(req: Request, res: Response, token: string): void {
  const claims = verifySession(token);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secure(req), path: "/", maxAge: claims ? Math.max(0, claims.exp * 1000 - Date.now()) : WEEK_MS });
}
export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: secure(req), path: "/" });
}
/** Issues the session: cookie sessions get a cookie and no token in the body, everyone else the token. */
export function issueSession(req: Request, res: Response, token: string): { token?: string } {
  if (!wantsCookieSession(req)) return { token };
  setSessionCookie(req, res, token);
  return {};
}
