import { asyncHandler } from "../http";
import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";

export const browseRouter = Router();
const pageSize = z.coerce.number().int().min(1).max(50).default(20);
const rowId = z.string().refine(id => ["recent", "movies", "series"].includes(id) || (id.startsWith("genre:") && id.length > 6 && id.length <= 506));
const rowQuery = z.object({ row: rowId, limit: pageSize, cursor: z.string().max(2048).optional() });
const homeQuery = z.object({ limit: pageSize, afterGenre: z.string().max(500).optional() });
const cursorSchema = z.object({ row: rowId, at: z.number().int().min(0).max(8640000000000000), id: z.string().min(1).max(200) });
type Card = { id: string; name: string; year: number | null; posterUrl: string | null; createdAt: Date };

// Genres are JSON strings in the existing SQLite schema. Query them exactly,
// without materializing descriptions or private source mappings in Node.
const genresJson = Prisma.sql`CASE WHEN json_valid(t.genres) THEN CASE WHEN json_type(t.genres) = 'array' THEN t.genres ELSE '[]' END ELSE '[]' END`;

async function rowPage(row: string, limit: number, cursor?: string) {
  let after = Prisma.empty;
  if (cursor) {
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (decoded.row !== row) throw new Error("Cursor belongs to another row");
    after = Prisma.sql`AND (t.createdAt < ${decoded.at} OR (t.createdAt = ${decoded.at} AND t.id < ${decoded.id}))`;
  }
  const filter = row === "movies" ? Prisma.sql`t.type = 'movie'`
    : row === "series" ? Prisma.sql`t.type = 'series'`
    : row.startsWith("genre:") ? Prisma.sql`EXISTS (SELECT 1 FROM json_each(${genresJson}) g WHERE g.type = 'text' AND g.value = ${row.slice(6)})`
    : Prisma.sql`1 = 1`;
  const records = await db.$queryRaw<Card[]>(Prisma.sql`
    SELECT t.id, t.name, t.year, t.posterUrl, t.createdAt FROM Title t
    WHERE ${filter} ${after} ORDER BY t.createdAt DESC, t.id DESC LIMIT ${limit + 1}
  `);
  const visible = records.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    id: row,
    label: row === "recent" ? "Recently added" : row === "movies" ? "Movies" : row === "series" ? "Series" : row.slice(6),
    titles: visible.map(({ createdAt: _at, ...card }) => card),
    nextCursor: records.length > limit && last ? Buffer.from(JSON.stringify({ row, at: last.createdAt.getTime(), id: last.id })).toString("base64url") : null,
  };
}

browseRouter.get("/row", asyncHandler(async (req, res, next) => {
  const parsed = rowQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid browse query" }); return; }
  const { row, limit, cursor } = parsed.data;
  // Reject malformed cursors before issuing SQL, without treating DB failures as input errors.
  if (cursor) {
    try {
      const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (decoded.row !== row) throw new Error("Wrong row");
    } catch { res.status(400).json({ error: "Invalid row cursor" }); return; }
  }
  try { res.json(await rowPage(row, limit, cursor)); } catch (err) { next(err); }
}));

browseRouter.get("/", asyncHandler(async (req, res, next) => {
  const parsed = homeQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid browse query" }); return; }
  const { limit, afterGenre } = parsed.data;
  try {
    const genres = await db.$queryRaw<Array<{ genre: string }>>(Prisma.sql`
      SELECT DISTINCT g.value AS genre FROM Title t, json_each(${genresJson}) g
      WHERE g.type = 'text' AND length(g.value) BETWEEN 1 AND 500
        ${afterGenre === undefined ? Prisma.empty : Prisma.sql`AND g.value > ${afterGenre}`}
      ORDER BY genre LIMIT 6
    `);
    const ids = [...(afterGenre === undefined ? ["recent", "movies", "series"] : []), ...genres.slice(0, 5).map(g => `genre:${g.genre}`)];
    const rows = await Promise.all(ids.map(id => rowPage(id, limit)));
    res.json({ rows: rows.filter(row => row.titles.length), nextGenre: genres.length > 5 ? genres[4].genre : null });
  } catch (err) { next(err); }
}));
