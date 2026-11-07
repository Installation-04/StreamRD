import { recordFor, storedMetadata } from "../metadata/automation";
import { asyncHandler } from "../http";
import { browseRouter } from "./browse";
import { NextFunction, Request, Response, Router } from "express";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { getServerSettings } from "../settings";
import { publicTitle } from "./helpers";

export const catalogRouter = Router();

/** Browsing may be public depending on the admin's server settings. */
async function browseGate(req: Request, res: Response, next: NextFunction) {
  const settings = await getServerSettings();
  if (settings.allowUnauthenticatedBrowse) {
    next();
    return;
  }
  await requireAuth(req, res, next);
}

catalogRouter.use(asyncHandler(browseGate));
catalogRouter.use("/browse", browseRouter);

/**
 * GET /api/catalog/rows — Netflix-style home rows: recently added,
 * movies, series, then one row per genre.
 */
catalogRouter.get("/rows", asyncHandler(async (_req, res) => {
  const titles = await db.title.findMany({ orderBy: { createdAt: "desc" } });
  const decoded = titles.map((t) => publicTitle(t));
  const byGenre = new Map<string, typeof decoded>();
  for (const title of decoded) {
    for (const genre of title.genres) {
      if (!byGenre.has(genre)) byGenre.set(genre, []);
      byGenre.get(genre)!.push(title);
    }
  }
  const rows = [
    { id: "recent", label: "Recently added", titles: decoded.slice(0, 20) },
    { id: "movies", label: "Movies", titles: decoded.filter((t) => t.type === "movie") },
    { id: "series", label: "Series", titles: decoded.filter((t) => t.type === "series") },
    ...[...byGenre.entries()].map(([genre, list]) => ({
      id: `genre:${genre}`,
      label: genre,
      titles: list,
    })),
  ].filter((row) => row.titles.length > 0);
  res.json({ rows });
}));

/** GET /api/catalog/search?q= */
catalogRouter.get("/search", asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json({ results: [] });
    return;
  }
  const titles = await db.title.findMany({
    where: {
      OR: [{ name: { contains: q } }, { description: { contains: q } }],
    },
    orderBy: { name: "asc" },
    take: 50,
  });
  res.json({ results: titles.map((t) => publicTitle(t)) });
}));

/** GET /api/catalog/title/:id */
catalogRouter.get("/title/:id", asyncHandler(async (req, res) => {
  const title = await db.title.findUnique({ where: { id: req.params.id } });
  if (!title) {
    res.status(404).json({ error: "Title not found" });
    return;
  }
  const metadata = await recordFor("catalog", title.id);
  res.json({ title: { ...publicTitle(title), metadata: storedMetadata(metadata?.data ?? "{}"), metadataStatus: metadata?.status ?? null } });
}));
