import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { searchIndexer } from "../indexers/torznab";
import { IndexerSearchResult } from "../indexers/types";
import { logEvent } from "../logger";
import { getServerSettings } from "../settings";

export const searchRouter = Router();
searchRouter.use(requireAuth);

type SortKey = "seeders" | "size" | "date";

/**
 * GET /api/search?q=&indexerId=&minSeeders=&maxSizeGb=&sort=seeders|size|date
 * Fans out to every enabled Torznab indexer (or a single one), merges,
 * filters and sorts results. Indexers that error are reported, not fatal.
 */
searchRouter.get("/", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json({ results: [], errors: [] });
    return;
  }
  const indexerId = req.query.indexerId ? String(req.query.indexerId) : undefined;
  const minSeeders = req.query.minSeeders ? parseInt(String(req.query.minSeeders), 10) : 0;
  const maxSizeGb = req.query.maxSizeGb ? parseFloat(String(req.query.maxSizeGb)) : undefined;
  const sort = (req.query.sort as SortKey) ?? "seeders";

  const [settings, indexers] = await Promise.all([
    getServerSettings(),
    db.indexerConfig.findMany({ where: { enabled: true, ...(indexerId ? { id: indexerId } : {}) } }),
  ]);
  if (indexers.length === 0) {
    res.json({ results: [], errors: ["No enabled indexers configured — ask an admin to add one under Admin → Indexers"] });
    return;
  }

  const outcomes = await Promise.allSettled(
    indexers.map((idx) =>
      searchIndexer(idx, q, { timeoutMs: settings.providerTimeoutMs, limit: settings.maxResultsPerIndexer })
    )
  );

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
});
