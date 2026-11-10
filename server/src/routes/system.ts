import { PRODUCT } from "../product";
import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { asyncHandler } from "../http";
import { logEvent } from "../logger";
import { systemStatus } from "../system";
import { rateLimit } from "../util/rateLimit";
import {
  MaintenanceError, backupPath, cancelRestore, checkForUpdates, createBackup, deleteBackup, listBackups, pendingRestore,
  requestUpdate, restartSoon, restartSupported, stageRestore, validBackupName, verifyBackup,
} from "../maintenance";
export const systemRouter = Router();
systemRouter.use(requireAuth, requireAdmin);
systemRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
systemRouter.get("/", asyncHandler(async (_req, res) => { res.json(await systemStatus(PRODUCT.id)); }));

function guarded(run: (req: Request, res: Response) => Promise<unknown>) {
  return asyncHandler(async (req, res) => {
    try { await run(req, res); }
    catch (error) { if (error instanceof MaintenanceError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
  });
}
const audit = (req: Request, message: string, meta: Record<string, unknown> = {}) => logEvent("info", "admin_action", message, { userId: req.session!.sub, meta });
const heavy = () => rateLimit({ windowMs: 60_000, max: 20 });
const name = (req: Request) => { if (!validBackupName(req.params.name)) throw new MaintenanceError("Backup not found.", 404); return req.params.name; };

systemRouter.get("/maintenance", guarded(async (_req, res) => {
  res.json({ backups: listBackups(), pendingRestore: pendingRestore(), restartSupported: restartSupported() });
}));
systemRouter.post("/backups", heavy(), guarded(async (req, res) => {
  const backup = await createBackup();
  await audit(req, "Created a database backup", { backup: backup.name });
  res.status(201).json({ backup });
}));
systemRouter.get("/backups/:name/download", heavy(), guarded(async (req, res) => {
  const file = backupPath(name(req));
  await audit(req, "Downloaded a database backup", { backup: req.params.name });
  res.setHeader("Content-Type", "application/octet-stream");
  res.download(file, req.params.name);
}));
systemRouter.post("/backups/:name/verify", heavy(), guarded(async (req, res) => { res.json(await verifyBackup(name(req))); }));
systemRouter.delete("/backups/:name", heavy(), guarded(async (req, res) => {
  deleteBackup(name(req));
  await audit(req, "Deleted a database backup", { backup: req.params.name });
  res.json({ ok: true });
}));
const restoreBody = z.object({ confirm: z.literal("RESTORE"), restart: z.boolean().optional() }).strict();
systemRouter.post("/backups/:name/restore", heavy(), guarded(async (req, res) => {
  const parsed = restoreBody.safeParse(req.body);
  if (!parsed.success) throw new MaintenanceError('Type RESTORE to confirm. Restoring replaces all current data after a safety backup.');
  const staged = await stageRestore(name(req), req.session!.sub);
  await audit(req, "Staged a database restore", { backup: req.params.name, safetyBackup: staged.preRestoreBackup.name });
  const restarting = parsed.data.restart === true && restartSupported();
  res.status(202).json({ ...staged, restarting });
  if (restarting) restartSoon();
}));
systemRouter.delete("/restore", guarded(async (req, res) => {
  const cancelled = cancelRestore();
  if (cancelled) await audit(req, "Cancelled a staged database restore");
  res.json({ cancelled });
}));
systemRouter.post("/restart", heavy(), guarded(async (req, res) => {
  if (!restartSupported()) throw new MaintenanceError("Restart is not available here. Restart the container or service yourself.", 409);
  await audit(req, "Requested a server restart");
  res.status(202).json({ restarting: true });
  restartSoon();
}));
systemRouter.get("/update", heavy(), guarded(async (req, res) => { res.json(await checkForUpdates(req.query.refresh === "1")); }));
systemRouter.post("/update", heavy(), guarded(async (req, res) => {
  const parsed = z.object({ version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/) }).strict().safeParse(req.body);
  if (!parsed.success) throw new MaintenanceError("Choose the available version to update to.");
  const result = await requestUpdate(parsed.data.version);
  await audit(req, "Requested an application update", { to: parsed.data.version, backup: result.backup.name });
  res.status(202).json({ requested: true, backup: result.backup });
}));
