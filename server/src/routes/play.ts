import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { logEvent } from "../logger";
import { debridManager } from "../providers/manager";
import { parseBody, titleSources } from "./helpers";

export const playRouter = Router();
playRouter.use(requireAuth);

const playSchema = z.object({
  titleId: z.string().min(1),
  /** Optional index into the title's source list to force a specific source. */
  sourceIndex: z.number().int().min(0).optional(),
});

/**
 * POST /api/play — resolve a stream URL for a title through the user's
 * debrid providers, recording a PlaybackLog either way.
 */
playRouter.post("/", async (req, res) => {
  const body = parseBody(playSchema, req.body, res);
  if (!body) return;
  const userId = req.session!.sub;
  const started = Date.now();

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
    const stream = await debridManager.resolveStream(cfg, sources);
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
});
