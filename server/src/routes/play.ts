import { asyncHandler } from "../http";
import { beginPlayback, mediaKeyFor, ownsProfile } from "../progress";
import { progressRouter } from "./progress";
import { FileSelectionRequired, InvalidFileSelection } from "../providers/files";
import { PROVIDER_IDS } from "../providers/types";
import { PendingSourceError } from "../providers/sourceJobs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { logEvent } from "../logger";
import { debridManager } from "../providers/manager";
import { parseBody, titleSources } from "./helpers";

export const playRouter = Router();
playRouter.use(requireAuth);
playRouter.use(progressRouter);

const playSchema = z.object({
  titleId: z.string().min(1),
  trackProgress: z.boolean().optional(),
  profileId: z.string().min(1).max(200).optional(),
  /** Optional index into the title's source list to force a specific source. */
  sourceIndex: z.number().int().min(0).optional(),
  selection: z.object({ provider: z.enum(PROVIDER_IDS), fileToken: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
}).refine(body => !body.selection || body.sourceIndex !== undefined, { message: "File choices require a source index" });

/**
 * POST /api/play — resolve a stream URL for a title through the user's
 * debrid providers, recording a PlaybackLog either way.
 */
playRouter.post("/", asyncHandler(async (req, res) => {
  const body = parseBody(playSchema, req.body, res);
  if (!body) return;
  const userId = req.session!.sub;
  const started = Date.now();
  if (!await ownsProfile(userId, body.profileId)) { res.status(404).json({ error: "Profile not found" }); return; }

  const title = await db.title.findUnique({ where: { id: body.titleId } });
  if (!title) {
    res.status(404).json({ error: "Title not found" });
    return;
  }
  let sources = titleSources(title);
  if (body.sourceIndex !== undefined) sources = sources.slice(body.sourceIndex, body.sourceIndex + 1);
  if (sources.length === 0) {
    res.status(409).json({ error: "This title has no playable sources yet" });
    return;
  }
  const cfg = await db.debridConfig.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });

  try {
    const stream = await debridManager.resolveStream(cfg, sources, body.selection);
    const playback = body.trackProgress ? await beginPlayback(userId, title.id, stream.mediaKey ?? mediaKeyFor(title.id, stream.filename, stream.filesize), body.profileId) : undefined;
    await db.playbackLog.create({
      data: {
        userId,
        titleId: title.id,
        providerUsed: stream.provider,
        success: true,
        durationMs: Date.now() - started,
      },
    });
    await logEvent("info", "playback", `Play "${title.name}" via ${stream.provider}`, {
      userId,
      provider: stream.provider,
    });
    res.json({
      ...(playback ? { playback } : {}),
      stream: {
        url: stream.url,
        filename: stream.filename,
        filesize: stream.filesize,
        mimeType: stream.mimeType,
        provider: stream.provider,
        quality: stream.quality,
        label: stream.label,
      },
      title: { id: title.id, name: title.name },
    });
  } catch (err) {
    if (err instanceof FileSelectionRequired) {
      res.status(409).json({ error: err.message, selectionRequired: true, files: err.files, provider: err.provider, sourceIndex: body.sourceIndex ?? err.sourceIndex });
      return;
    }
    if (err instanceof InvalidFileSelection) { res.status(409).json({ error: err.message }); return; }
    if (err instanceof PendingSourceError) {
      // Preserve the legacy error status; new clients can explicitly retry pending work.
      res.status(502).json({ error: err.message, pending: true, retryAfterMs: 5000, progress: err.progress });
      return;
    }
    const message = (err as Error).message;
    await db.playbackLog.create({
      data: {
        userId,
        titleId: title.id,
        providerUsed: "none",
        success: false,
        durationMs: Date.now() - started,
        error: message,
      },
    });
    await logEvent("error", "playback", `Playback failed for "${title.name}": ${message}`, {
      userId,
    });
    res.status(502).json({ error: message });
  }
}));
