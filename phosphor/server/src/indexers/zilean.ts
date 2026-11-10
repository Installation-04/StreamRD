import { db } from "../db";
import { logEvent } from "../logger";
import { clearIndexerSearchCache } from "./searchCache";

/**
 * When the operator runs Zilean next to this server (get.sh --zilean sets ZILEAN_URL), register it as a Torznab
 * indexer once. It never overwrites an existing entry, so an administrator can rename, disable or delete it.
 */
export async function ensureZileanIndexer(env: NodeJS.ProcessEnv = process.env): Promise<"created" | "exists" | "skipped"> {
  const raw = env.ZILEAN_URL?.trim();
  if (!raw) return "skipped";
  let base: URL;
  try { base = new URL(raw); } catch { return "skipped"; }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return "skipped";
  const baseUrl = `${base.origin}/torznab/api`;
  const existing = await db.indexerConfig.findFirst({ where: { baseUrl } });
  if (existing) return "exists";
  // Zilean's Torznab endpoint is unauthenticated; the field only needs a value.
  await db.indexerConfig.create({ data: { name: "Zilean", baseUrl, apiKey: env.ZILEAN_API_KEY?.trim() || "zilean", enabled: true } });
  clearIndexerSearchCache();
  await logEvent("info", "system", "Registered the Zilean indexer from ZILEAN_URL");
  return "created";
}
