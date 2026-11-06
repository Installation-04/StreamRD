import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { config } from "../config";
import { asyncHandler } from "../http";
import { LibraryError, libraryBrowseQuery, libraryInput, MediaLibrary } from "../library";

export const mediaLibrary = new MediaLibrary(() => ({ sourceRoot: config.mediaSourceRoot, exportRoot: config.mediaLibraryRoot }));
export const libraryRouter = Router();
libraryRouter.use(requireAuth, requireAdmin);
// Filesystem details are deliberately confined to the administrator-only API.
function action(run: (req: import("express").Request, res: import("express").Response) => Promise<void>) {
  return asyncHandler(async (req, res) => {
    try { await run(req, res); }
    catch (e) {
      if (e instanceof LibraryError) { res.status(e.status).json({ error: e.message }); return; }
      // Do not return local paths or filesystem exception messages.
      res.status(503).json({ error: "Media library operation failed; check mount access, permissions, and available storage" });
    }
  });
}
libraryRouter.get("/", action(async (_req, res) => { res.json(await mediaLibrary.list()); }));
libraryRouter.get("/files", action(async (req, res) => {
  const parsed = libraryBrowseQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid media browse path, cursor, or page size" }); return; }
  res.json(await mediaLibrary.browse(parsed.data));
}));
libraryRouter.post("/entries/batch", action(async (req, res) => {
  if (!Array.isArray(req.body?.items) || req.body.items.length < 1 || req.body.items.length > 100) { res.status(400).json({ error: "Choose between 1 and 100 files per export batch" }); return; }
  res.json(await mediaLibrary.addBatch(req.body.items));
}));
libraryRouter.post("/entries", action(async (req, res) => {
  const parsed = libraryInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Supply a name, movie/episode type, relative video path, and episode numbers when needed" }); return; }
  res.status(201).json({ entry: await mediaLibrary.add(parsed.data) });
}));
libraryRouter.delete("/entries/:id", action(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) { res.status(400).json({ error: "Invalid library entry ID" }); return; }
  await mediaLibrary.remove(req.params.id); res.json({ ok: true });
}));
libraryRouter.post("/repair", action(async (_req, res) => { res.json({ results: await mediaLibrary.repair() }); }));
