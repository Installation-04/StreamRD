import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";
import { MediaTag, mediaTags } from "../media-tags";
import { validateMagnet } from "./clients";
import { prowlarrSources } from "../prowlarr";

/**
 * Finds a release for a request by itself. Indexers are Torznab endpoints (Prowlarr, Jackett, or Zilean, which the installer can run);
 * the administrator adds them in Admin → Requests, and ZILEAN_URL is picked up on its own. Results are matched to the requested title,
 * ranked for what plays well in a browser, and the best one becomes the magnet the approval submits.
 */
const KEY = "requests.indexers";
export interface Indexer { id: string; name: string; baseUrl: string; apiKey: string; builtin?: boolean }
export class FinderError extends Error { constructor(message: string, public status = 409) { super(message); } }
const stored = z.array(z.object({ id: z.string().max(60), name: z.string().max(80), baseUrl: z.string().max(2048), apiKey: z.string().max(1500) }));

/** Public http(s) or local-network endpoints are fine (Prowlarr runs next to the server); credentials in the URL and other schemes are not. */
export function indexerUrl(value: string): string {
  let url: URL; try { url = new URL(value.trim()); } catch { throw new FinderError("Use the full Torznab URL, for example http://prowlarr:9696/1/api", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new FinderError("Use an http(s) Torznab URL without a user name or password in it.", 400);
  return url.href;
}
async function readStored(): Promise<Indexer[]> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  try { return stored.parse(JSON.parse(row?.value ?? "[]")).map(entry => ({ ...entry, apiKey: decryptSecret(entry.apiKey) ?? "" })); } catch { return []; }
}
const writeStored = (list: Indexer[]) => {
  const value = JSON.stringify(list.filter(entry => !entry.builtin).map(({ id, name, baseUrl, apiKey }) => ({ id, name, baseUrl, apiKey: encryptSecret(apiKey) })));
  return db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
};
/** Zilean next to this server (install.sh --zilean sets ZILEAN_URL) needs no setup. */
function builtin(env: NodeJS.ProcessEnv = process.env): Indexer[] {
  const raw = env.ZILEAN_URL?.trim(); if (!raw) return [];
  try { const base = new URL(raw); if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return []; return [{ id: "zilean", name: "Zilean", baseUrl: `${base.origin}/torznab/api`, apiKey: env.ZILEAN_API_KEY?.trim() || "zilean", builtin: true }]; } catch { return []; }
}
export async function listIndexers(): Promise<Indexer[]> { return [...builtin(), ...await prowlarrSources(), ...await readStored()]; }
export const publicIndexer = (indexer: Indexer) => ({ id: indexer.id, name: indexer.name, baseUrl: indexer.baseUrl, hasKey: Boolean(indexer.apiKey), builtin: Boolean(indexer.builtin) });
export async function addIndexer(input: { name: string; baseUrl: string; apiKey: string }): Promise<Indexer> {
  const list = await readStored();
  if (list.length >= 20) throw new FinderError("At most 20 indexers.", 409);
  const entry = { id: randomUUID(), name: input.name.trim().slice(0, 80) || "Indexer", baseUrl: indexerUrl(input.baseUrl), apiKey: input.apiKey.trim() };
  await writeStored([...list, entry]); return entry;
}
export async function removeIndexer(id: string): Promise<boolean> {
  const list = await readStored(), next = list.filter(entry => entry.id !== id);
  if (next.length === list.length) return false;
  await writeStored(next); return true;
}

// ---- Torznab (the same protocol Prowlarr, Jackett and Zilean speak).
export interface Raw { title: string; hash: string | null; magnet: string | null; sizeBytes: number; seeders: number; source: string }
const unxml = (value: string) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
const tag = (block: string, name: string) => { const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block); return match ? unxml(match[1]) : ""; };
/** Reads the items of a Torznab feed. Written by hand (a feed is flat) so no XML library is needed. */
export function parseTorznab(xml: string, source: string): Raw[] {
  const items: Raw[] = [];
  for (const match of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = match[0], attrs: Record<string, string> = {};
    for (const attr of block.matchAll(/<(?:torznab|newznab):attr\s+name="([^"]+)"\s+value="([^"]*)"/gi)) attrs[attr[1].toLowerCase()] = unxml(attr[2]);
    const title = tag(block, "title"), link = tag(block, "link"), enclosure = /<enclosure[^>]*\burl="([^"]*)"/i.exec(block)?.[1];
    const magnet = [attrs.magneturl, link, enclosure && unxml(enclosure)].find(value => value?.startsWith("magnet:")) ?? null;
    let hash = /^[a-f0-9]{40}$/i.test(attrs.infohash ?? "") ? attrs.infohash.toLowerCase() : null;
    if (!hash && magnet) hash = /xt=urn:btih:([a-f0-9]{40})(?:&|$)/i.exec(magnet)?.[1]?.toLowerCase() ?? null;
    if (!title || (!hash && !magnet)) continue;
    items.push({ title, hash, magnet, source, sizeBytes: Number.parseInt(attrs.size ?? tag(block, "size") ?? "0", 10) || 0, seeders: Number.parseInt(attrs.seeders ?? "0", 10) || 0 });
  }
  return items;
}
async function query(indexer: Indexer, q: string, type: "movie" | "series", timeoutMs: number): Promise<Raw[]> {
  const url = new URL(indexer.baseUrl);
  url.searchParams.set("t", type === "series" ? "tvsearch" : "search"); url.searchParams.set("q", q); url.searchParams.set("apikey", indexer.apiKey); url.searchParams.set("limit", "60");
  const response = await fetch(url, { headers: { Accept: "application/xml, text/xml, */*", "User-Agent": "streamrd-requests" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`${indexer.name} answered ${response.status}`); }
  const text = await response.text();
  if (text.length > 6_000_000) throw new Error(`${indexer.name} sent too much`);
  return parseTorznab(text, indexer.name);
}
export async function testIndexer(indexer: Indexer): Promise<{ ok: boolean; results: number; message: string }> {
  try { const results = await query(indexer, "matrix", "movie", 15_000); return { ok: true, results: results.length, message: results.length ? `Working: ${results.length} results for a test search.` : "Reachable, but the test search found nothing." }; }
  catch (error) { return { ok: false, results: 0, message: error instanceof Error && /answered 401|answered 403/.test(error.message) ? "The indexer refused the API key." : "The indexer could not be reached or did not answer like a Torznab feed." }; }
}

// ---- Matching and ranking (pure; tested without a network).
const words = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export interface Wanted { name: string; year: number | null; type: "movie" | "series" }
export interface Candidate { title: string; magnet: string; hash: string; sizeBytes: number; seeders: number; source: string; tags: MediaTag[]; score: number; pack: boolean }
const BAD = /(?:^|[^a-z0-9])(cam|hdcam|ts|hdts|telesync|tc|telecine|screener|scr|dvdscr|workprint|sample|3d|hsbs|korsub|hardsub)(?:[^a-z0-9]|$)/i;
/** Whether a release is the wanted title: every word of the name in order, and no different year after it. Sequels ("Crank High Voltage") do not match "Crank". */
export function matchesTitle(wanted: Wanted, release: string): boolean {
  const name = words(wanted.name), text = ` ${words(release.replace(/\.(mkv|mp4|avi)$/i, ""))} `, at = text.indexOf(` ${name} `);
  if (!name || at < 0) return false;
  const after = text.slice(at + name.length + 1).trim();
  if (wanted.type !== "movie") return true;
  const years = [...after.matchAll(/(?:^|\s)((?:19|20)\d\d)(?:\s|$)/g)].map(match => Number(match[1]));
  if (wanted.year && years.length) return years.includes(wanted.year);
  // No year in the name: a following word that is not a quality word ("high voltage") usually means a sequel or another film.
  const next = after.split(" ")[0] ?? "";
  return !next || /^(?:\d{3,4}p|4k|uhd|bluray|brrip|bdrip|web|webrip|webdl|hdtv|dvdrip|remux|x264|x265|h264|h265|hevc|avc|aac|dts|ac3|eac3|ddp|multi|dual|proper|repack|extended|unrated|directors|remastered|imax|hdr|hdr10|dv|10bit)$/.test(next);
}
const RESOLUTION: Record<string, number> = { "1080p": 100, "4K": 80, "720p": 60, "480p": 20 };
export function rank(wanted: Wanted, raws: Raw[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const raw of raws) {
    if (!matchesTitle(wanted, raw.title) || BAD.test(raw.title)) continue;
    const hash = raw.hash ?? /xt=urn:btih:([a-f0-9]{40})/i.exec(raw.magnet ?? "")?.[1]?.toLowerCase(); if (!hash) continue;
    const magnet = raw.magnet ?? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(raw.title)}`;
    try { validateMagnet(magnet); } catch { continue; }
    const tags = mediaTags(raw.title), has = (kind: string, label: string) => tags.some(tag => tag.kind === kind && tag.label === label), resolution = tags.find(tag => tag.kind === "resolution")?.label ?? "";
    const pack = wanted.type === "series" && !/s\d{1,2}e\d{1,3}/i.test(raw.title) && /(?:season|\bs\d{1,2}\b|complete|\bs\d{1,2}[ .-]+s?\d{1,2}\b)/i.test(raw.title);
    if (wanted.type === "series" && !pack && /s\d{1,2}e\d{1,3}/i.test(raw.title)) continue; // a single episode is not a show
    let score = (RESOLUTION[resolution] ?? 10);
    score += has("source", "WEB") || has("source", "BluRay") ? 30 : has("source", "HDTV") ? 15 : has("source", "Remux") ? 10 : has("source", "DVD") ? 5 : 0;
    score += has("video", "H.264") ? 20 : has("video", "HEVC") ? 10 : 0;
    score += has("audio", "AAC") ? 10 : has("audio", "AC3") || has("audio", "EAC3") ? 8 : has("audio", "DTS") ? 5 : 0;
    score += Math.min(30, Math.round(Math.log2(raw.seeders + 1) * 5));
    if (pack) score += 25;
    const gb = raw.sizeBytes / 1024 ** 3;
    if (raw.sizeBytes && wanted.type === "movie" && (gb < 0.3 || gb > 30)) score -= 40;
    if (has("video", "10-bit") && !has("video", "HEVC")) score -= 10;
    const candidate: Candidate = { title: raw.title, magnet, hash, sizeBytes: raw.sizeBytes, seeders: raw.seeders, source: raw.source, tags, score, pack };
    const earlier = seen.get(hash); if (!earlier || earlier.score < score) seen.set(hash, candidate);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || b.seeders - a.seeders);
}

/** Searches every indexer for the wanted title; one that fails does not stop the others. */
export async function findReleases(wanted: Wanted): Promise<{ candidates: Candidate[]; indexers: number; errors: string[] }> {
  const indexers = await listIndexers();
  if (!indexers.length) throw new FinderError("No indexer is set up. Add one in Admin → Requests (Prowlarr, Jackett or Zilean), or paste a magnet.");
  const queries = [...new Set([wanted.type === "movie" && wanted.year ? `${wanted.name} ${wanted.year}` : wanted.name, wanted.name])].slice(0, 2), errors: string[] = [], raws: Raw[] = [];
  await Promise.all(indexers.map(async indexer => {
    for (const q of queries) {
      try { raws.push(...await query(indexer, q, wanted.type, 20_000)); if (raws.some(raw => raw.source === indexer.name && matchesTitle(wanted, raw.title))) break; }
      catch (error) { errors.push(error instanceof Error ? error.message : `${indexer.name} failed`); break; }
    }
  }));
  return { candidates: rank(wanted, raws), indexers: indexers.length, errors };
}
export async function findBest(wanted: Wanted): Promise<Candidate> {
  const { candidates, errors } = await findReleases(wanted);
  if (!candidates.length) throw new FinderError(`No release of “${wanted.name}”${wanted.year ? ` (${wanted.year})` : ""} was found${errors.length ? ` (${errors[0]})` : ""}. Paste a magnet by hand, or try again later.`);
  return candidates[0];
}
