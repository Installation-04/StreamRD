import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { db } from "../db";
import { mediaLibrary } from "../library-instance";
import { queueAutomaticTargets, storedMetadata } from "../metadata/automation";
export { mediaLibrary } from "../library-instance";
import { asyncHandler } from "../http";
import { LibraryError, libraryBrowseQuery, libraryInput } from "../library";

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
libraryRouter.get("/", action(async (_req, res) => {
  const listing = await mediaLibrary.list();
  const records = new Map<string, { data: string; status: string }>();
  for (let start = 0; start < listing.entries.length; start += 500) {
    const page = await db.metadataRecord.findMany({ where: { targetType: "library", targetId: { in: listing.entries.slice(start, start + 500).map(entry => entry.id) } }, select: { targetId: true, data: true, status: true } });
    for (const record of page) records.set(record.targetId, record);
  }
  res.json({ ...listing, entries: listing.entries.map(entry => ({ ...entry, metadata: storedMetadata(records.get(entry.id)?.data ?? "{}"), metadataStatus: records.get(entry.id)?.status ?? null })) });
}));
libraryRouter.get("/files", action(async (req, res) => {
  const parsed = libraryBrowseQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid media browse path, cursor, or page size" }); return; }
  res.json(await mediaLibrary.browse(parsed.data));
}));
libraryRouter.post("/entries/batch", action(async (req, res) => {
  if (!Array.isArray(req.body?.items) || req.body.items.length < 1 || req.body.items.length > 100) { res.status(400).json({ error: "Choose between 1 and 100 files per export batch" }); return; }
  const result = await mediaLibrary.addBatch(req.body.items);
  await queueAutomaticTargets(result.results.filter(item => item.status === "exported" && item.entry).map(item => ({ targetType: "library", targetId: item.entry!.id, name: item.entry!.media.name, mediaType: item.entry!.media.type === "episode" ? "series" : "movie", year: item.entry!.media.year ?? null }))).catch(() => {});
  res.json(result);
}));
libraryRouter.post("/entries", action(async (req, res) => {
  const parsed = libraryInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Supply a name, movie/episode type, relative video path, and episode numbers when needed" }); return; }
  const entry = await mediaLibrary.add(parsed.data);
  await queueAutomaticTargets([{ targetType: "library", targetId: entry.id, name: entry.media.name, mediaType: entry.media.type === "episode" ? "series" : "movie", year: entry.media.year ?? null }]).catch(() => {});
  res.status(201).json({ entry });
}));
libraryRouter.delete("/entries/:id", action(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) { res.status(400).json({ error: "Invalid library entry ID" }); return; }
  await mediaLibrary.remove(req.params.id);
  await db.metadataRecord.deleteMany({ where: { targetType: "library", targetId: req.params.id } }); res.json({ ok: true });
}));
libraryRouter.post("/repair", action(async (_req, res) => { res.json({ results: await mediaLibrary.repair() }); }));
