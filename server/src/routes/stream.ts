import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "../util/rateLimit";
import { asyncHandler } from "../http";
import { alignedStart, reportStreamProblem, streamConverted, streamStatus } from "../transcode";

/**
 * Converted playback. The path carries an unguessable, short-lived id handed out by an authorised play request (see transcode.ts), so a
 * <video> element can use it without sending credentials, and the provider link never reaches the browser.
 */
export const streamRouter = Router();
// video=1: the player's request after the browser failed to decode a copied picture; the server then re-encodes it (see transcode.ts).
const query = z.object({ start: z.coerce.number().finite().min(0).max(604_800).default(0), video: z.literal("1").optional() }).strict();
streamRouter.get("/:id", rateLimit({ windowMs: 60_000, max: 120 }), asyncHandler(async (req, res) => {
  const id = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).safeParse(req.params.id), parsed = query.safeParse(req.query);
  if (!id.success || !parsed.success) { res.status(400).json({ error: "Invalid stream request." }); return; }
  streamConverted(id.data, parsed.data.start, res, parsed.data.video === "1");
}));
/** Where a stream asked to start at `at` will really start (see alignedStart): the player shows its position from this. */
streamRouter.get("/:id/start", rateLimit({ windowMs: 60_000, max: 120 }), asyncHandler(async (req, res) => {
  const id = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).safeParse(req.params.id), parsed = z.object({ at: z.coerce.number().finite().min(0).max(604_800).default(0), video: z.literal("1").optional() }).strict().safeParse(req.query);
  if (!id.success || !parsed.success) { res.status(400).json({ error: "Invalid stream request." }); return; }
  const start = await alignedStart(id.data, parsed.data.at, parsed.data.video === "1");
  if (start === null) { res.status(404).json({ error: "This stream has expired. Open the video again." }); return; }
  res.setHeader("Cache-Control", "no-store"); res.json({ start });
}));
/** Why a converted stream did not play, for the player to tell the viewer (no link, no file names). */
streamRouter.get("/:id/status", rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
  const id = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: "Invalid stream request." }); return; }
  res.setHeader("Cache-Control", "no-store"); res.json(streamStatus(id.data));
});
/** The player's account of why it stopped (browser family, kind of problem, how far it got): written to the log, nothing else. */
const problem = z.object({
  kind: z.enum(["network", "decode", "unsupported", "stalled", "memory", "other"]), detail: z.string().trim().max(160).default(""),
  browser: z.enum(["Firefox", "Chrome", "Safari", "Edge", "other"]).default("other"), at: z.number().finite().min(0).max(604_800).default(0), code: z.number().int().min(0).max(10).nullable().default(null),
}).strict();
streamRouter.post("/:id/problem", rateLimit({ windowMs: 60_000, max: 12 }), asyncHandler(async (req, res) => {
  const id = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).safeParse(req.params.id), parsed = problem.safeParse(req.body ?? {});
  if (!id.success || !parsed.success) { res.status(400).json({ error: "Invalid report." }); return; }
  res.status(reportStreamProblem(id.data, parsed.data) ? 204 : 404).end();
}));
