import { PrismaClient } from "@prisma/client";

/** Single shared Prisma client. Tests point DATABASE_URL at a temp file. */
export const db = new PrismaClient();

/**
 * Write-ahead logging lets readers and the background workers proceed while one writer commits,
 * which avoids "database is locked" stalls. The mode is stored in the database file, so this is a
 * no-op after the first start. Set SQLITE_WAL=false on network file systems, where WAL is unsafe.
 */
export async function enableWal(): Promise<void> {
  if (process.env.SQLITE_WAL === "false" || !process.env.DATABASE_URL?.startsWith("file:")) return;
  try { await db.$queryRawUnsafe("PRAGMA journal_mode=WAL"); } catch { /* keep the default journal; never block startup */ }
}
