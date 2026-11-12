import { runtime } from "./runtime-settings";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "./db";
import { version } from "../package.json";
import { PRODUCT } from "./product";

const run = promisify(execFile);
const MAX_MANUAL_BACKUPS = 20;
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.db$/;
const UPDATE_SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export class MaintenanceError extends Error { constructor(message: string, public status = 400) { super(message); } }

type Scripts = {
  databaseFile: (root: string, url: string | undefined) => string;
  inspectDatabase: (options: { root: string; url: string | undefined }) => Promise<{ state: string; reason?: string | null }>;
};
function serverRoot(): string {
  const candidates = [path.resolve(__dirname, ".."), path.resolve(__dirname, "../..")];
  return candidates.find(root => fs.existsSync(path.join(root, "prisma/schema.prisma"))) ?? candidates[0];
}
function scripts(root: string): Scripts { return require(path.join(root, "scripts/database-state.cjs")) as Scripts; }
function paths() {
  const root = serverRoot();
  let file: string;
  try { file = scripts(root).databaseFile(root, process.env.DATABASE_URL); }
  catch { throw new MaintenanceError("Backups require a SQLite database file.", 409); }
  const directory = path.join(path.dirname(file), "backups");
  return { root, file, directory, marker: path.join(path.dirname(file), "restore-pending.json") };
}
export type BackupKind = "manual" | "pre-update" | "pre-restore" | "pre-upgrade" | "other";
export interface BackupInfo { name: string; kind: BackupKind; sizeBytes: number; createdAt: string }
function kindOf(name: string): BackupKind {
  const prefix = name.split("-")[0];
  return prefix === "manual" ? "manual" : name.startsWith("pre-update-") ? "pre-update" : name.startsWith("pre-restore-") ? "pre-restore" : name.startsWith("pre-upgrade-") ? "pre-upgrade" : "other";
}
export function validBackupName(name: unknown): name is string { return typeof name === "string" && BACKUP_NAME.test(name); }
export function listBackups(): BackupInfo[] {
  const { directory } = paths();
  if (!fs.existsSync(directory)) return [];
  const rows: BackupInfo[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !validBackupName(entry.name)) continue;
    const stat = fs.statSync(path.join(directory, entry.name));
    if (stat.size === 0) continue; // a reserved, never-completed snapshot
    rows.push({ name: entry.name, kind: kindOf(entry.name), sizeBytes: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name)).slice(0, 200);
}
export function pendingRestore(): { backup: string; requestedAt: string } | null {
  const { marker } = paths();
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8")) as { backup?: unknown; requestedAt?: unknown };
    return validBackupName(value.backup) && typeof value.requestedAt === "string" ? { backup: value.backup, requestedAt: value.requestedAt } : null;
  } catch { return null; }
}
let busy = false;
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (busy) throw new MaintenanceError("Another backup, restore or update is already running.", 409);
  busy = true;
  try { return await work(); } finally { busy = false; }
}
/** Verified SQLite snapshot using the same script the upgrade runner uses; never overwrites. */
async function snapshot(prefix: string): Promise<BackupInfo> {
  const { root, file, directory } = paths();
  if (!fs.existsSync(file)) throw new MaintenanceError("The database file could not be found.", 409);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(6).toString("hex")}.db`;
  try {
    await run(process.execPath, [path.join(root, "scripts/backup-db.cjs"), path.join(directory, name)], { cwd: root, env: { ...process.env, DATABASE_URL: `file:${file}` }, timeout: 120000 });
  } catch {
    fs.rmSync(path.join(directory, name), { force: true });
    throw new MaintenanceError("The backup could not be created or verified. Nothing was changed.", 500);
  }
  const stat = fs.statSync(path.join(directory, name));
  return { name, kind: kindOf(name), sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
}
export function createBackup(): Promise<BackupInfo> {
  return exclusive(async () => {
    if (listBackups().filter(backup => backup.kind === "manual").length >= MAX_MANUAL_BACKUPS) throw new MaintenanceError(`You can keep at most ${MAX_MANUAL_BACKUPS} manual backups. Delete one first.`, 409);
    return snapshot("manual");
  });
}
function existing(name: string) {
  if (!validBackupName(name)) throw new MaintenanceError("Backup not found.", 404);
  const { directory } = paths(), file = path.join(directory, name);
  const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
  if (!stat?.isFile() || stat.size === 0) throw new MaintenanceError("Backup not found.", 404);
  return file;
}
export function backupPath(name: string): string { return existing(name); }
export function deleteBackup(name: string): void {
  const file = existing(name);
  if (pendingRestore()?.backup === name) throw new MaintenanceError("This backup is staged for restore and cannot be deleted.", 409);
  fs.rmSync(file);
}
/** Integrity, foreign keys and a recognized schema; the live database is never touched. */
export async function verifyBackup(name: string): Promise<{ ok: true; schema: string } | { ok: false; reason: string }> {
  const file = existing(name), { root } = paths();
  const state = await scripts(root).inspectDatabase({ root, url: `file:${file}` });
  if (["current", "pending", "unmanaged"].includes(state.state)) return { ok: true, schema: state.state };
  return { ok: false, reason: state.reason ?? state.state };
}
/**
 * Stage a restore. The swap happens at the next start, before any writer opens the file,
 * so a running process never has its database replaced underneath it.
 */
export function stageRestore(name: string, requestedBy: string): Promise<{ preRestoreBackup: BackupInfo; restartRequired: true }> {
  return exclusive(async () => {
    const checked = await verifyBackup(name);
    if (!checked.ok) throw new MaintenanceError("This file is not a restorable StreamRD backup (" + checked.reason + ").", 422);
    if (pendingRestore()) throw new MaintenanceError("A restore is already staged. Restart the server or cancel it first.", 409);
    const preRestoreBackup = await snapshot("pre-restore");
    const { marker } = paths();
    fs.writeFileSync(marker, JSON.stringify({ backup: name, requestedAt: new Date().toISOString(), requestedBy }) + "\n", { mode: 0o600, flag: "wx" });
    return { preRestoreBackup, restartRequired: true as const };
  });
}
export function cancelRestore(): boolean {
  const { marker } = paths();
  if (!fs.existsSync(marker)) return false;
  fs.rmSync(marker);
  return true;
}
/**
 * A restart from the web page is offered where something will bring the server back: the helper, which restarts the container whatever
 * its restart policy is, or a supervisor the operator declared (ADMIN_RESTART=true), for which the process simply exits.
 */
function helper(): { base: string; token: string } | null {
  const raw = process.env.MEDIA_MANAGER_URL, token = process.env.MEDIA_MANAGER_TOKEN;
  if (!raw || !token) return null;
  try { const url = new URL(raw); return ["http:", "https:"].includes(url.protocol) ? { base: url.origin, token } : null; } catch { return null; }
}
export function restartSupported(): boolean { return process.env.ADMIN_RESTART === "true" || helper() !== null; }
export function restartSoon(): void { setTimeout(() => process.exit(0), 800).unref(); }
/** Asks for the restart and returns once it is certain to happen; the caller answers the browser before the server goes away. */
export async function requestRestart(): Promise<void> {
  const via = helper();
  if (via) {
    let status = 0;
    try { const response = await fetch(`${via.base}/restart`, { method: "POST", headers: { Authorization: `Bearer ${via.token}` }, signal: AbortSignal.timeout(8000), redirect: "error" }); status = response.status; await response.body?.cancel(); }
    catch { /* decided below */ }
    if (status === 202) return;
    if (status === 409) throw new MaintenanceError("The server is already restarting or updating. Give it a minute.", 409);
    if (process.env.ADMIN_RESTART !== "true") throw new MaintenanceError("The helper that restarts the server did not answer. Check that its container (streamrd-media-manager) is running.", 502);
  }
  if (process.env.ADMIN_RESTART !== "true" && !via) throw new MaintenanceError("Restart is not available here. Restart the container or service yourself.", 409);
  restartSoon();
}

// ---- Update checks and the operator-configured update hook ----
export interface UpdateInfo {
  current: string; latest: string | null; updateAvailable: boolean; publishedAt: string | null; url: string | null;
  checkEnabled: boolean; checkedAt: string | null; error: string | null; canApply: boolean; updater: "helper" | "webhook" | null;
}
let cache: { at: number; latest: string; publishedAt: string | null; url: string | null } | null = null;
function parse(value: string): number[] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function updateWebhook(): URL | null {
  const raw = process.env.UPDATE_WEBHOOK_URL;
  if (!raw) return null;
  try { const url = new URL(raw); return ["http:", "https:"].includes(url.protocol) ? url : null; } catch { return null; }
}
/** Who rolls out an update: the operator's own hook, or else the media manager helper, which replaces the StreamRD container itself. */
export function updateTarget(): { url: URL; token: string; helper: boolean } | null {
  const hook = updateWebhook();
  if (hook) return { url: hook, token: process.env.UPDATE_WEBHOOK_TOKEN ?? "", helper: false };
  const base = process.env.MEDIA_MANAGER_URL, token = process.env.MEDIA_MANAGER_TOKEN;
  if (!base || !token) return null;
  try { const url = new URL("/update", base); return ["http:", "https:"].includes(url.protocol) ? { url, token, helper: true } : null; } catch { return null; }
}
export async function checkForUpdates(force = false): Promise<UpdateInfo> {
  const base: UpdateInfo = { current: version, latest: null, updateAvailable: false, publishedAt: null, url: null, checkEnabled: runtime().updateCheck, checkedAt: null, error: null, canApply: updateTarget() !== null, updater: updateTarget() ? (updateTarget()!.helper ? "helper" : "webhook") : null };
  if (!base.checkEnabled) return base;
  const repository = process.env.UPDATE_REPOSITORY ?? "Installation-04/StreamRD";
  if (!UPDATE_SLUG.test(repository)) return { ...base, error: "UPDATE_REPOSITORY is not a valid owner/name." };
  if (!force && cache && Date.now() - cache.at < 30 * 60 * 1000) return fill(base, cache);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": `${PRODUCT.id}-update-check` }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json() as { tag_name?: unknown; published_at?: unknown; html_url?: unknown };
    if (typeof body.tag_name !== "string" || !parse(body.tag_name)) throw new Error("unrecognized-release");
    const link = typeof body.html_url === "string" && body.html_url.startsWith("https://github.com/") ? body.html_url : null;
    cache = { at: Date.now(), latest: body.tag_name.replace(/^v/, ""), publishedAt: typeof body.published_at === "string" ? body.published_at : null, url: link };
    return fill(base, cache);
  } catch { return { ...base, error: "The latest release could not be checked. Try again later." }; }
}
function fill(base: UpdateInfo, found: NonNullable<typeof cache>): UpdateInfo {
  return { ...base, latest: found.latest, publishedAt: found.publishedAt, url: found.url, checkedAt: new Date(found.at).toISOString(), updateAvailable: isNewer(found.latest, base.current) };
}
export function clearUpdateCache(): void { cache = null; }
/** Back up first, then ask the operator's updater (for example a host-side script or Watchtower) to roll out. */
export function requestUpdate(targetVersion: string): Promise<{ backup: BackupInfo; status: number }> {
  return exclusive(async () => {
    const hook = updateTarget();
    if (!hook) throw new MaintenanceError("No updater is set up. Run install.sh --media-manager, or set UPDATE_WEBHOOK_URL (see the admin guide).", 409);
    const info = await checkForUpdates(true);
    if (!info.latest || info.latest !== targetVersion || !info.updateAvailable) throw new MaintenanceError("That version is not the available update. Check for updates again.", 409);
    const backup = await snapshot("pre-update");
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": `${PRODUCT.id}-update` };
    if (hook.token) headers.Authorization = `Bearer ${hook.token}`;
    let status: number;
    try {
      const response = await fetch(hook.url, { method: "POST", headers, body: JSON.stringify({ product: PRODUCT.id, from: version, to: targetVersion }), signal: AbortSignal.timeout(15000), redirect: "error" });
      status = response.status;
      if (!response.ok) throw new Error(String(status));
    } catch { throw new MaintenanceError("The update hook did not accept the request. Your backup was kept; nothing was changed.", 502); }
    return { backup, status };
  });
}
export async function databaseIsUp(): Promise<boolean> { try { await db.$queryRaw`SELECT 1`; return true; } catch { return false; } }
