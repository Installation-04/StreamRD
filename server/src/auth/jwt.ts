import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config";
export type Role = "user" | "admin";
export interface SessionClaims { sub: string; email: string; role: Role; version: number; jti: string; exp: number }
type SessionInput = Pick<SessionClaims, "sub" | "email" | "role"> & { version?: number };
export function signSession(claims: SessionInput): string {
  return jwt.sign({ ...claims, version: claims.version ?? 0 }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn, algorithm: "HS256", issuer: "streamrd", jwtid: randomUUID(),
  } as jwt.SignOptions);
}
export function verifySession(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: "streamrd" });
    if (typeof payload === "string") return null;
    const { sub, email, role, version, jti, exp } = payload;
    if (typeof sub !== "string" || !sub || typeof email !== "string" || !email || !["user", "admin"].includes(role) || !Number.isInteger(version) || version < 0 || typeof jti !== "string" || !jti || !Number.isInteger(exp)) return null;
    return { sub, email, role, version, jti, exp } as SessionClaims;
  } catch { return null; }
}
