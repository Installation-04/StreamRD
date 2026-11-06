import { asyncHandler } from "../http";
import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";

export const accountListsRouter = Router();
const cardSelect = { id: true, name: true, year: true, posterUrl: true } as const;
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(2048).optional() });
const cursorSchema = z.object({ kind: z.enum(["favorites", "history"]), userId: z.string().min(1), at: z.number().int().min(0).max(8640000000000000), id: z.string().min(1).max(200) });
type Cursor = z.infer<typeof cursorSchema>;
function decode(cursor: string | undefined, kind: Cursor["kind"], userId: string): Cursor | undefined {
  if (!cursor) return;
  const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  if (value.kind !== kind || value.userId !== userId) throw new Error("Wrong cursor scope");
  return value;
}
const encode = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Aggregate before applying the page limit: repeated plays cannot crowd out other titles. */
export async function historyPage(userId: string, limit: number, cursor?: Cursor) {
  return db.$queryRaw<Array<{ titleId: string; playedAt: bigint | number }>>(Prisma.sql`
    SELECT titleId, MAX(createdAt) AS playedAt FROM PlaybackLog
    WHERE userId = ${userId} AND success = 1 GROUP BY titleId
    ${cursor ? Prisma.sql`HAVING MAX(createdAt) < ${cursor.at} OR (MAX(createdAt) = ${cursor.at} AND titleId < ${cursor.id})` : Prisma.empty}
    ORDER BY playedAt DESC, titleId DESC LIMIT ${limit}
  `);
}

for (const kind of ["favorites", "history"] as const) {
  accountListsRouter.get(kind === "favorites" ? "/favorites/page" : "/continue-watching/page", asyncHandler(async (req, res, next) => {
    const parsed = querySchema.safeParse(req.query);
    const userId = req.session!.sub;
    let cursor: Cursor | undefined;
    try {
      if (!parsed.success) throw new Error("Invalid query");
      cursor = decode(parsed.data.cursor, kind, userId);
    } catch { res.status(400).json({ error: "Invalid list query or cursor" }); return; }
    const { limit } = parsed.data;
    try {
      if (kind === "favorites") {
        const rows = await db.favorite.findMany({
          where: { userId, ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
          select: { id: true, createdAt: true, title: { select: cardSelect } },
        });
        const page = rows.slice(0, limit), last = page[page.length - 1];
        res.json({ titles: page.map(row => row.title), nextCursor: rows.length > limit && last ? encode({ kind, userId, at: last.createdAt.getTime(), id: last.id }) : null });
      } else {
        const rows = await historyPage(userId, limit + 1, cursor);
        const page = rows.slice(0, limit), last = page[page.length - 1];
        const titles = await db.title.findMany({ where: { id: { in: page.map(row => row.titleId) } }, select: cardSelect });
        const byId = new Map(titles.map(title => [title.id, title]));
        res.json({ titles: page.flatMap(row => byId.has(row.titleId) ? [byId.get(row.titleId)!] : []), nextCursor: rows.length > limit && last ? encode({ kind, userId, at: Number(last.playedAt), id: last.titleId }) : null });
      }
    } catch (err) { next(err); }
  }));
}

// Query only visible cards, rather than downloading every favorite ID on login.
accountListsRouter.post("/favorites/status", asyncHandler(async (req, res, next) => {
  const parsed = z.object({ titleIds: z.array(z.string().min(1).max(200)).max(200) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid favorite status request" }); return; }
  try {
    const titleIds = [...new Set(parsed.data.titleIds)];
    const rows = await db.favorite.findMany({ where: { userId: req.session!.sub, titleId: { in: titleIds } }, select: { titleId: true } });
    res.json({ favoriteIds: rows.map(row => row.titleId) });
  } catch (err) { next(err); }
}));
