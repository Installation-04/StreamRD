import type { PrismaClient } from "@prisma/client";

/** This port is never published by the installer or compose file. */
export const BUNDLED_QBIT_PORT = 8082;
export const validPeerHost = (value: string) => /^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(value) && !/^[0-9.]+$/.test(value) && !value.toLowerCase().endsWith(".localhost") && !["localhost", "bridge", "host", "none"].includes(value.toLowerCase());
export function isBundledQbitUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === String(BUNDLED_QBIT_PORT) && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function bundledPeerHost(): string {
  const host = process.env.BUNDLED_QBIT_HOST ?? "";
  return validPeerHost(host) ? host : "";
}
export function bundledAccessActive(): boolean { return Boolean(bundledPeerHost()) && process.env.BUNDLED_QBIT_ACCESS_ACTIVE === "true"; }

/** Startup reads policy without decrypting secrets or changing the database. */
export async function approvedBundledHost(client: Pick<PrismaClient, "setting" | "user">, host: string): Promise<string> {
  if (!validPeerHost(host)) return "";
  try {
    const row = await client.setting.findUnique({ where: { key: "requests.qbit" } });
    const value = JSON.parse(row?.value ?? "null");
    if (!value || value.enabled !== true || value.shareWithAddons !== true || value.allowBundledAccess !== true || !isBundledQbitUrl(value.baseUrl) || typeof value.username !== "string" || !value.username || typeof value.password !== "string" || !value.password || typeof value.ownerId !== "string" || !value.ownerId) return "";
    return await client.user.findFirst({ where: { id: value.ownerId, active: true, role: "admin" }, select: { id: true } }) ? host : "";
  } catch { return ""; }
}
