import { createHash } from "node:crypto";
import { searchIndexer } from "./torznab";
import { IndexerConfigInput, IndexerSearchResult } from "./types";
import { TtlCache } from "../util/ttlCache";
import { BoundedExecutor } from "../util/boundedExecutor";
const cache = new TtlCache<IndexerSearchResult[]>(30_000);
const executor = new BoundedExecutor(4, 128);
export const clearIndexerSearchCache = () => cache.clear();

export function cachedIndexerSearch(indexer: IndexerConfigInput & { updatedAt?: Date }, query: string, opts: { timeoutMs: number; limit: number }) {
  // Include the full configuration snapshot and exact query. Hash keys rather
  // than leaving API keys embedded in an in-memory cache-key string.
  const key = createHash("sha256").update(JSON.stringify([indexer.id, indexer.name, indexer.baseUrl, indexer.apiKey, indexer.updatedAt, query, opts])).digest("hex");
  return cache.getOrSet(key, () => executor.run(() => searchIndexer(indexer, query, opts)));
}
