import jwt from "jsonwebtoken";
import { config } from "../config";

export type Role = "user" | "admin";

export interface SessionClaims {
  sub: string;
  email: string;
  role: Role;
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === "string") return null;
    const { sub, email, role } = payload as jwt.JwtPayload & SessionClaims;
    if (!sub || (role !== "user" && role !== "admin")) return null;
    return { sub, email, role };
  } catch {
    return null;
  }
}
