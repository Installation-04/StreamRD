import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "../util/rateLimit";
import { streamConverted, streamStatus } from "../transcode";

/**
 * Converted playback. The path carries an unguessable, short-lived id handed out by an authorised play request (see transcode.ts), so a
 * <video> element can use it without sending credentials, and the provider link never reaches the browser.
 */
export const streamRouter = Router();
const query = z.object({ start: z.coerce.number().finite().min(0).max(604_800).default(0) }).strict();
streamRouter.get("/:id", rateLimit({ windowMs: 60_000, max: 120 }), (req, res) => {
  const id = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).safeParse(req.params.id), parsed = query.safeParse(req.query);
  if (!id.success || !parsed.success) { res.status(400).json({ error: "Invalid stream request." }); return; }
  streamConverted(id.data, parsed.data.start, res);
});
/** Why a converted stream did not play, for the player to tell the viewer (no link, no file names). */
streamRouter.get("/:id/status", rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
  const id = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: "Invalid stream request." }); return; }
  res.setHeader("Cache-Control", "no-store"); res.json(streamStatus(id.data));
});
