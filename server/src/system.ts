import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { config } from "./config";
import { version } from "../package.json";

type MigrationState = "current" | "unmanaged" | "pending" | "failed" | "drifted" | "unavailable";
type Inspection = { state: MigrationState; applied: number; total: number; pending: string[]; failed: string[]; reason: string | null; lastAppliedAt: string | null };
const states = new Set<MigrationState>(["current", "unmanaged", "pending", "failed", "drifted", "unavailable"]);
function serverRoot(): string {
  // tsx runs from src/, production runs from dist/src/. Neither uses a caller's cwd.
  const candidates = [path.resolve(__dirname, ".."), path.resolve(__dirname, "../..")];
  return candidates.find(root => fs.existsSync(path.join(root, "prisma/schema.prisma"))) ?? candidates[0];
}
function safeNames(names: unknown): string[] {
  return Array.isArray(names) ? names.slice(0, 200).map(name => typeof name === "string" && /^[A-Za-z0-9_-]{1,140}$/.test(name) ? name : "unrecognized-migration") : [];
}
function safeCount(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0; }
/** Read-only upgrade diagnostics; no schema changes, backups, or upstream calls. */
export async function systemStatus(product: "streamrd" | "phosphor") {
  let up = true;
  try { await db.$queryRaw`SELECT 1`; } catch { up = false; }
  let migrations: Inspection = { state: "unavailable", applied: 0, total: 0, pending: [], failed: [], reason: "database-unavailable", lastAppliedAt: null };
  if (up) {
    try {
      const root = serverRoot();
      const { inspectDatabase } = require(path.join(root, "scripts/database-state.cjs")) as { inspectDatabase: (options: { root: string; url: string | undefined; db: typeof db }) => Promise<Inspection> };
      const inspection = await inspectDatabase({ root, url: process.env.DATABASE_URL, db });
      const timestamp = inspection.lastAppliedAt ? new Date(inspection.lastAppliedAt) : null;
      migrations = {
        state: states.has(inspection.state) ? inspection.state : "unavailable",
        applied: safeCount(inspection.applied), total: safeCount(inspection.total),
        pending: safeNames(inspection.pending), failed: safeNames(inspection.failed),
        reason: typeof inspection.reason === "string" && /^[a-z][a-z0-9-]{0,80}$/.test(inspection.reason) ? inspection.reason : null,
        lastAppliedAt: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null,
      };
    } catch { migrations.reason = "inspection-unavailable"; }
  }
  return {
    product, version, checkedAt: new Date().toISOString(), runtime: { nodeVersion: process.version },
    database: { status: up ? "up" as const : "down" as const }, migrations,
    upgrade: { automatic: process.env.APPLY_SCHEMA_ON_START !== "false", backupPolicy: "verified-before-changes" as const },
    media: { configured: Boolean(config.mediaSourceRoot && config.mediaLibraryRoot) },
  };
}
