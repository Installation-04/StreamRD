import { asyncHandler } from "../http";
import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { ownsProfile } from "../progress";

export const progressRouter = Router();
const writeSchema = z.object({
  sessionId: z.string().min(1).max(200), sequence: z.number().int().min(0).max(2147483647),
  positionSeconds: z.number().finite().min(0).max(604800), durationSeconds: z.number().finite().positive().max(604800),
}).refine(body => body.positionSeconds <= body.durationSeconds + 1, { message: "Position exceeds duration" });

progressRouter.put("/progress", asyncHandler(async (req, res, next) => {
  const parsed = writeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid playback progress" }); return; }
  try {
    const body = parsed.data;
    const session = await db.playbackSession.findFirst({ where: { id: body.sessionId, userId: req.session!.sub } });
    if (!session) { res.status(404).json({ error: "Playback session not found" }); return; }
    if (session.expiresAt.getTime() <= Date.now()) { res.status(410).json({ error: "Playback session expired" }); return; }
    const positionSeconds = Math.min(body.positionSeconds, body.durationSeconds);
    const completed = positionSeconds >= body.durationSeconds * 0.95;
    const accepted = await db.$transaction(async tx => {
      const current = await tx.playbackSession.updateMany({ where: { id: session.id, lastSequence: { lt: body.sequence } }, data: { lastSequence: body.sequence } });
      if (!current.count) return { accepted: false, reason: "out-of-order" };
      const saved = await tx.playbackProgress.updateMany({
        where: { userId: session.userId, scope: session.scope, titleId: session.titleId, mediaKey: session.mediaKey, activeSessionId: session.id },
        data: { positionSeconds, durationSeconds: body.durationSeconds, completed, updatedAt: new Date() },
      });
      return saved.count ? { accepted: true } : { accepted: false, reason: "superseded" };
    });
    res.json(accepted);
  } catch (err) { next(err); }
}));

const querySchema = z.object({ profileId: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(2048).optional() });
const cursorSchema = z.object({ userId: z.string(), scope: z.string(), at: z.number().int().min(0), id: z.string().min(1) });
progressRouter.get("/continue", asyncHandler(async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid progress query" }); return; }
  const { profileId, limit, cursor } = parsed.data, userId = req.session!.sub, scope = profileId ?? "";
  let after = Prisma.empty;
  if (cursor) {
    try {
      const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (decoded.userId !== userId || decoded.scope !== scope) throw new Error("Wrong scope");
      after = Prisma.sql`AND (p.updatedAt < ${decoded.at} OR (p.updatedAt = ${decoded.at} AND p.id < ${decoded.id}))`;
    } catch { res.status(400).json({ error: "Invalid progress cursor" }); return; }
  }
  try {
    if (!await ownsProfile(userId, profileId)) { res.status(404).json({ error: "Profile not found" }); return; }
    type Row = { progressId: string; id: string; name: string; year: number | null; posterUrl: string | null; positionSeconds: number; durationSeconds: number; mediaKey: string; updatedAt: Date };
    const records = await db.$queryRaw<Row[]>(Prisma.sql`
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY titleId ORDER BY updatedAt DESC, id DESC) AS rank
        FROM PlaybackProgress WHERE userId = ${userId} AND scope = ${scope} AND completed = 0 AND positionSeconds > 0
      )
      SELECT p.id AS progressId, t.id, t.name, t.year, t.posterUrl, p.positionSeconds, p.durationSeconds, p.mediaKey, p.updatedAt
      FROM ranked p JOIN Title t ON t.id = p.titleId WHERE p.rank = 1 ${after}
      ORDER BY p.updatedAt DESC, p.id DESC LIMIT ${limit + 1}
    `);
    const page = records.slice(0, limit), last = page[page.length - 1];
    res.json({ titles: page.map(({ progressId: _id, updatedAt: _at, ...title }) => title), nextCursor: records.length > limit && last ? Buffer.from(JSON.stringify({ userId, scope, at: last.updatedAt.getTime(), id: last.progressId })).toString("base64url") : null });
  } catch (err) { next(err); }
}));
