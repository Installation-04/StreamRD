import { asyncHandler } from "../http";
import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { cachedIndexerSearch, clearIndexerSearchCache } from "../indexers/searchCache";
import { IndexerSearchResult } from "../indexers/types";
import { logEvent } from "../logger";
import { getServerSettings } from "../settings";
import { z } from "zod";

export const searchRouter = Router();
searchRouter.use(requireAuth);

/** Preserved for existing tests/consumers. */
export const clearSearchCache = clearIndexerSearchCache;
const querySchema = z.object({
  q: z.string().max(500).default(""), indexerId: z.string().min(1).max(200).optional(),
  minSeeders: z.coerce.number().int().min(0).max(2147483647).default(0),
  maxSizeGb: z.coerce.number().finite().min(0).optional(), sort: z.enum(["seeders", "size", "date"]).default("seeders"),
});

/**
 * GET /api/search?q=&indexerId=&minSeeders=&maxSizeGb=&sort=seeders|size|date
 * Fans out to every enabled Torznab indexer (or a single one), merges,
 * filters and sorts results. Indexers that error are reported, not fatal.
 */
searchRouter.get("/", asyncHandler(async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid search query" }); return; }
  const { indexerId, minSeeders, maxSizeGb, sort } = parsed.data;
  const q = parsed.data.q.trim();
  if (!q) {
    res.json({ results: [], errors: [] });
    return;
  }
  try {
    const [settings, indexers] = await Promise.all([
      getServerSettings(),
      db.indexerConfig.findMany({ where: { enabled: true, ...(indexerId ? { id: indexerId } : {}) } }),
    ]);
    if (indexers.length === 0) {
      res.json({ results: [], errors: ["No enabled indexers configured — ask an admin to add one under Admin → Indexers"] });
      return;
    }

    const outcomes = await Promise.allSettled(indexers.map(idx => cachedIndexerSearch(idx, q, {
      timeoutMs: settings.providerTimeoutMs, limit: settings.maxResultsPerIndexer,
    })));

    const results: IndexerSearchResult[] = [];
    const errors: string[] = [];
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") results.push(...outcome.value);
      else errors.push(`${indexers[i].name}: ${outcome.reason?.message ?? "search failed"}`);
    });

    const filtered = results.filter(
      (r) => r.seeders >= minSeeders && (maxSizeGb === undefined || r.sizeBytes <= maxSizeGb * 1024 ** 3)
    );
    filtered.sort((a, b) => {
      if (sort === "size") return b.sizeBytes - a.sizeBytes;
      if (sort === "date") return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
      return b.seeders - a.seeders;
    });

    await logEvent("info", "search", `Search "${q}" → ${filtered.length} results`, { userId: req.session!.sub });
    res.json({ results: filtered, errors });
  } catch (err) { next(err); }
}));
