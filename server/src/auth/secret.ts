import { randomBytes } from "node:crypto";

export function jwtSecretFor(nodeEnv: string, configured?: string): string {
  const known = ["change-me-to-a-long-random-string", "streamrd-dev-secret-change-me", "phosphor-dev-secret-change-me"];
  if (!["development", "test"].includes(nodeEnv) && (!configured || Buffer.byteLength(configured.trim()) < 32 || known.includes(configured.trim().toLowerCase()))) {
    throw new Error("JWT_SECRET must be a non-placeholder secret of at least 32 bytes outside development/test");
  }
  return configured || randomBytes(32).toString("hex");
}
