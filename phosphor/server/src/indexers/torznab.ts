import { XMLParser } from "fast-xml-parser";
import { fetchWithTimeout } from "../util/fetchTimeout";
import { IndexerConfigInput, IndexerSearchResult } from "./types";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => name === "item" });

interface TorznabAttr {
  "@_name"?: string;
  "@_value"?: string;
}

interface TorznabItem {
  title?: string;
  link?: string;
  pubDate?: string;
  size?: string;
  enclosure?: { "@_url"?: string; "@_length"?: string };
  "torznab:attr"?: TorznabAttr | TorznabAttr[];
}

function attrMap(item: TorznabItem): Record<string, string> {
  const raw = item["torznab:attr"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const map: Record<string, string> = {};
  for (const a of list) {
    if (a["@_name"] && a["@_value"] !== undefined) map[a["@_name"].toLowerCase()] = a["@_value"];
  }
  return map;
}

function toResult(item: TorznabItem, indexer: IndexerConfigInput): IndexerSearchResult {
  const attrs = attrMap(item);
  const magnet = attrs.magneturl ?? (item.link?.startsWith("magnet:") ? item.link : undefined);
  const link = magnet ?? item.enclosure?.["@_url"] ?? item.link ?? "";
  const sizeBytes = parseInt(attrs.size ?? item.enclosure?.["@_length"] ?? item.size ?? "0", 10) || 0;
  return {
    indexerId: indexer.id,
    indexerName: indexer.name,
    title: item.title ?? "Untitled",
    link,
    hasMagnet: link.startsWith("magnet:"),
    sizeBytes,
    seeders: parseInt(attrs.seeders ?? "0", 10) || 0,
    peers: parseInt(attrs.peers ?? "0", 10) || 0,
    publishedAt: item.pubDate ?? null,
  };
}

/**
 * Queries a Torznab-compatible endpoint (Jackett's per-indexer or "all"
 * feed, or a Prowlarr indexer's Torznab URL — both speak the same protocol,
 * so the admin just pastes whichever URL their tool gives them).
 */
export async function searchIndexer(
  indexer: IndexerConfigInput,
  query: string,
  opts: { timeoutMs?: number; limit?: number } = {}
): Promise<IndexerSearchResult[]> {
  const qs = new URLSearchParams({ t: "search", q: query, apikey: indexer.apiKey });
  const res = await fetchWithTimeout(`${indexer.baseUrl}?${qs}`, {}, opts.timeoutMs ?? 15000);
  if (!res.ok) throw new Error(`${indexer.name}: HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = parser.parse(xml) as { rss?: { channel?: { item?: TorznabItem[] } } };
  const items = parsed.rss?.channel?.item ?? [];
  const results = items.map((item) => toResult(item, indexer));
  return opts.limit ? results.slice(0, opts.limit) : results;
}
