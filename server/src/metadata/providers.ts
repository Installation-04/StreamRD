import { createHash } from "node:crypto";
import { PRODUCT } from "../product";
import { activeProvider, getMetadataSettings, providerCredential } from "./settings";
import { MediaType, MetadataCandidate, MetadataDetails, MetadataError, MetadataProvider, MetadataSettings } from "./types";
export { MetadataError } from "./types";

const TMDB = "https://api.themoviedb.org/3", OMDB = "https://www.omdbapi.com/", FREE = "https://v3-cinemeta.strem.io", WIKIDATA = "https://www.wikidata.org/w/api.php";
/** Posters of the built-in source are served from this host only. */
const FREE_IMAGE_HOST = "images.metahub.space";
const MAX_BYTES = 1024 * 1024, FREE_MAX_BYTES = 4 * 1024 * 1024 /* a long series lists every episode */, MAX_CACHE = 200, TIMEOUT_MS = 8000;
const cache = new Map<string, { expires: number; value: unknown }>();
const flights = new Map<string, Promise<unknown>>();
let active = 0;
const waiters: Array<() => void> = [];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 20000): string => typeof value === "string" && value !== "N/A" ? value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : "";
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const imdbId = (value: unknown): string | null => typeof value === "string" && /^tt\d{7,10}$/.test(value) ? value : null;
const tmdbId = (value: unknown): string | null => ((typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 9999999999) || (typeof value === "string" && /^[1-9]\d{0,9}$/.test(value))) ? String(value) : null;
async function acquire() {
  if (active < 2) { active++; return; }
  if (waiters.length >= 20) throw new MetadataError("metadata-busy", 429, "Metadata lookups are busy; try again shortly.");
  await new Promise<void>(resolve => waiters.push(resolve));
}
function release() { const next = waiters.shift(); if (next) next(); else active--; }
function failure(code = "metadata-unavailable", status = 503): MetadataError {
  const messages: Record<string, string> = {
    "metadata-unavailable": "The metadata provider is unavailable; try again later.",
    "metadata-authentication-failed": "The metadata provider rejected its credentials; check the saved API key.",
    "metadata-rate-limited": "The metadata provider's request limit was reached; try again later.",
    "metadata-not-found": "The selected metadata title was not found.",
    "metadata-invalid-response": "The metadata provider returned an unsupported response; try again later.",
  };
  return new MetadataError(code, status, messages[code] ?? messages["metadata-unavailable"]);
}
function configured(settings: MetadataSettings, provider: MetadataProvider): string {
  if (provider === "free") return "built-in"; // needs no account or key
  const key = providerCredential(settings, provider); // the administrator's key, or the project's shared TMDB key
  if (!key) throw new MetadataError("metadata-not-configured", 503, `Configure ${provider === "tmdb" ? "TMDB" : "OMDb"} in Metadata settings before looking up titles.`);
  return key;
}
function validType(type: unknown): asserts type is MediaType {
  if (type !== "movie" && type !== "series") throw new MetadataError("metadata-input-invalid", 400, "Choose movie or series metadata.");
}
function validProvider(provider: unknown): asserts provider is MetadataProvider {
  if (provider !== "tmdb" && provider !== "omdb" && provider !== "free") throw new MetadataError("metadata-input-invalid", 400, "Choose TMDB, OMDb or the built-in source as the metadata provider.");
}
function image(value: unknown, width: "w500" | "w1280" = "w500"): string | null {
  const path = text(value, 1000);
  return /^\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp)$/i.test(path) && !path.includes("..") ? `https://image.tmdb.org/t/p/${width}${path}` : null;
}
function poster(value: unknown): string | null {
  try {
    const url = new URL(text(value, 2000));
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    // OMDb's separate keyed Poster API must never be exposed to the browser.
    return ["m.media-amazon.com", "ia.media-imdb.com", "images-na.ssl-images-amazon.com"].includes(url.hostname.toLowerCase()) ? url.href : null;
  } catch { return null; }
}
function year(value: unknown): number | null {
  const found = /^(\d{4})(?:-|$|–)/.exec(text(value, 30));
  return found && Number(found[1]) >= 1800 && Number(found[1]) <= 2200 ? Number(found[1]) : null;
}
function strings(value: unknown, limit: number, max: number): string[] {
  return Array.isArray(value) ? [...new Set(value.map(item => text(item, max)).filter(Boolean))].slice(0, limit) : [];
}
async function request(provider: MetadataProvider, path: string, parameters: Record<string, string>, settings: MetadataSettings): Promise<Record<string, unknown>> {
  const credential = configured(settings, provider), url = new URL(provider === "tmdb" ? TMDB + path : provider === "omdb" ? OMDB : FREE + path);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "tmdb") {
    if (/^[a-f0-9]{32}$/i.test(credential)) url.searchParams.set("api_key", credential);
    else headers.Authorization = `Bearer ${credential}`;
  } else if (provider === "omdb") url.searchParams.set("apikey", credential);
  else headers["User-Agent"] = `${PRODUCT.id}-metadata`;
  const limit = provider === "free" ? FREE_MAX_BYTES : MAX_BYTES;
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  await acquire();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref();
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw failure("metadata-authentication-failed", 502);
      if (response.status === 429) throw failure("metadata-rate-limited", 429);
      if (response.status === 404) throw failure("metadata-not-found", 404);
      throw failure();
    }
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel().catch(() => {}); throw failure("metadata-invalid-response", 502); }
    const reader = response.body?.getReader();
    if (!reader) throw failure("metadata-invalid-response", 502);
    let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > limit) throw failure("metadata-invalid-response", 502);
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("metadata-invalid-response", 502);
    const data = object(body);
    if (provider === "tmdb" && data.success === false) {
      if ([3, 7, 10, 14, 16, 17, 30, 31, 32, 33, 35].includes(Number(data.status_code))) throw failure("metadata-authentication-failed", 502);
      if (Number(data.status_code) === 25) throw failure("metadata-rate-limited", 429);
      if (Number(data.status_code) === 34) throw failure("metadata-not-found", 404);
      throw failure();
    }
    if (provider === "omdb" && data.Response === "False") {
      const message = typeof data.Error === "string" ? data.Error : "";
      if (/invalid api key|no api key|inactive api key|not activated/i.test(message)) throw failure("metadata-authentication-failed", 502);
      if (/request limit|too many requests|limit reached/i.test(message)) throw failure("metadata-rate-limited", 429);
      if (/not found/i.test(message)) throw failure("metadata-not-found", 404);
      if (/too many results/i.test(message)) throw new MetadataError("metadata-query-too-broad", 400, "The metadata search is too broad; add a more specific title or year.");
      throw failure();
    }
    return data;
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    // Native fetch/JSON errors can contain keyed URLs; never propagate them.
    throw failure();
  } finally { clearTimeout(timer); release(); }
}
async function cached<T>(provider: MetadataProvider, parameters: unknown, settings: MetadataSettings, ttl: number, refresh: boolean | undefined, operation: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(JSON.stringify([provider, configured(settings, provider), settings.language, parameters])).digest("hex");
  const running = flights.get(key);
  if (running) return structuredClone(await running) as T;
  const hit = cache.get(key);
  if (!refresh && hit && hit.expires > Date.now()) { cache.delete(key); cache.set(key, hit); return structuredClone(hit.value) as T; }
  if (flights.size >= 22) throw new MetadataError("metadata-busy", 429, "Metadata lookups are busy; try again shortly.");
  const work = operation().then(value => {
    cache.delete(key); cache.set(key, { expires: Date.now() + ttl, value: structuredClone(value) });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    return value;
  });
  flights.set(key, work);
  try { return structuredClone(await work); } finally { flights.delete(key); }
}
function tmdbCandidate(data: Record<string, unknown>, type: MediaType): MetadataCandidate | null {
  const id = tmdbId(data.id), name = text(type === "movie" ? data.title : data.name, 300);
  if (!id || !name || data.adult === true) return null;
  return { provider: "tmdb", id, type, name, year: year(type === "movie" ? data.release_date : data.first_air_date), posterUrl: image(data.poster_path), description: text(data.overview) };
}
function omdbCandidate(data: Record<string, unknown>, type: MediaType): MetadataCandidate | null {
  const id = imdbId(data.imdbID), name = text(data.Title, 300);
  if (!id || !name || data.Type !== type) return null;
  return { provider: "omdb", id, type, name, year: year(data.Year), posterUrl: poster(data.Poster), description: text(data.Plot) };
}
function freeImage(value: unknown): string | null {
  try {
    const url = new URL(text(value, 2000));
    return url.protocol === "https:" && url.hostname === FREE_IMAGE_HOST && !url.username && !url.password && !url.port && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
function freeCandidate(data: Record<string, unknown>, type: MediaType): MetadataCandidate | null {
  const id = imdbId(data.imdb_id) ?? imdbId(data.id), name = text(data.name, 300);
  if (!id || !name || (data.type !== undefined && data.type !== type)) return null;
  const released = typeof data.year === "number" ? String(data.year) : data.year ?? data.releaseInfo;
  return { provider: "free", id, type, name, year: year(released), posterUrl: freeImage(data.poster), description: text(data.description) };
}
/**
 * The built-in catalogue search misses some titles (short films, for example). Wikidata, a free public database, knows most of them
 * with their IMDb ID, so when no catalogue result is named as typed the title is looked up there and each IMDb ID it returns is read from the
 * catalogue like any other. Only the title text is sent; any failure simply means no extra results.
 */
async function wikidataImdbIds(query: string): Promise<string[]> {
  const get = async (parameters: Record<string, string>): Promise<Record<string, unknown>> => {
    const url = new URL(WIKIDATA); for (const [key, value] of Object.entries({ format: "json", ...parameters })) url.searchParams.set(key, value);
    await acquire();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref();
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": `${PRODUCT.id}-metadata` }, signal: controller.signal, redirect: "error" });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw failure(); }
      const declared = Number(response.headers.get("content-length")); if (declared > FREE_MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw failure(); }
      const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.byteLength > FREE_MAX_BYTES) throw failure();
      return object(JSON.parse(bytes.toString("utf8")));
    } finally { clearTimeout(timer); release(); }
  };
  try {
    const found = await get({ action: "wbsearchentities", search: query, language: "en", uselang: "en", type: "item", limit: "8" });
    const ids = (Array.isArray(found.search) ? found.search : []).map(item => object(item).id).filter((id): id is string => typeof id === "string" && /^Q\d{1,12}$/.test(id)).slice(0, 8);
    if (!ids.length) return [];
    const entities = object(object(await get({ action: "wbgetentities", ids: ids.join("|"), props: "claims" })).entities), result: string[] = [];
    for (const id of ids) {
      const claims = object(object(entities[id]).claims).P345;
      for (const claim of Array.isArray(claims) ? claims : []) {
        const value = object(object(object(claim).mainsnak).datavalue).value, found = imdbId(value);
        if (found && !result.includes(found)) result.push(found);
      }
    }
    return result.slice(0, 5);
  } catch { return []; }
}
export interface MetadataSearchInput { query: string; type: MediaType; year?: number; provider?: MetadataProvider; refresh?: boolean }
export async function searchMetadata(input: MetadataSearchInput, settings?: MetadataSettings): Promise<MetadataCandidate[]> {
  settings ??= await getMetadataSettings();
  validType(input.type); const provider = input.provider ?? activeProvider(settings); validProvider(provider);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 200 || /[\x00-\x1f]/.test(query) || (input.year !== undefined && (!Number.isInteger(input.year) || input.year < 1800 || input.year > 2200))) throw new MetadataError("metadata-input-invalid", 400, "Supply a title or IMDb ID and a valid year.");
  return cached(provider, ["search", query, input.type, input.year], settings, 15 * 60 * 1000, input.refresh, async () => {
    const identity = imdbId(query);
    if (provider === "free") {
      try {
        if (identity) {
          const found = await request("free", `/meta/${input.type}/${identity}.json`, {}, settings), item = freeCandidate(object(found.meta), input.type);
          return item ? [item] : [];
        }
        const data = await request("free", `/catalog/${input.type}/top/search=${encodeURIComponent(query)}.json`, {}, settings);
        if (!Array.isArray(data.metas)) throw failure("metadata-invalid-response", 502);
        const listed = data.metas.slice(0, 20).map(value => freeCandidate(object(value), input.type)).filter((value): value is MetadataCandidate => value !== null);
        const plain = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, ""), wanted = plain(query);
        // The catalogue's search is fuzzy: it can answer with loosely related titles instead of nothing, so ask Wikidata unless a result is named exactly as typed.
        if (!wanted || listed.some(item => plain(item.name) === wanted)) return listed;
        const extra: MetadataCandidate[] = [];
        for (const found of await wikidataImdbIds(query)) {
          try {
            const meta = await request("free", `/meta/${input.type}/${found}.json`, {}, settings), item = freeCandidate(object(meta.meta), input.type);
            if (item && item.id === found) extra.push(item);
          } catch (error) { if (error instanceof MetadataError && error.code === "metadata-rate-limited") break; }
        }
        return [...extra, ...listed.filter(item => !extra.some(other => other.id === item.id))].slice(0, 20);
      } catch (error) { if (error instanceof MetadataError && error.code === "metadata-not-found") return []; throw error; }
    }
    if (provider === "tmdb") {
      const path = identity ? `/find/${identity}` : `/search/${input.type === "movie" ? "movie" : "tv"}`;
      const parameters: Record<string, string> = identity ? { external_source: "imdb_id", language: settings.language } : { query, language: settings.language, include_adult: "false", page: "1" };
      if (input.year !== undefined && !identity) parameters[input.type === "movie" ? "year" : "first_air_date_year"] = String(input.year);
      const data = await request(provider, path, parameters, settings), list = data[identity ? input.type === "movie" ? "movie_results" : "tv_results" : "results"];
      if (!Array.isArray(list)) throw failure("metadata-invalid-response", 502);
      return list.slice(0, 20).map(value => tmdbCandidate(object(value), input.type)).filter((value): value is MetadataCandidate => value !== null);
    }
    try {
      const parameters: Record<string, string> = identity ? { i: identity, plot: "full", type: input.type } : { s: query, type: input.type, page: "1" };
      if (input.year !== undefined && !identity) parameters.y = String(input.year);
      const data = await request(provider, "", parameters, settings);
      if (identity) { const item = omdbCandidate(data, input.type); return item ? [item] : []; }
      if (!Array.isArray(data.Search)) throw failure("metadata-invalid-response", 502);
      return data.Search.slice(0, 20).map(value => omdbCandidate(object(value), input.type)).filter((value): value is MetadataCandidate => value !== null);
    } catch (error) { if (error instanceof MetadataError && error.code === "metadata-not-found") return []; throw error; }
  });
}
export interface MetadataFetchInput { provider: MetadataProvider; id: string; type: MediaType; refresh?: boolean }
export async function fetchMetadata(input: MetadataFetchInput, settings?: MetadataSettings): Promise<MetadataDetails> {
  settings ??= await getMetadataSettings();
  validProvider(input.provider); validType(input.type);
  if (!(input.provider === "tmdb" ? tmdbId(input.id) : imdbId(input.id))) throw new MetadataError("metadata-input-invalid", 400, "Choose a valid provider title ID.");
  return cached(input.provider, ["detail", input.id, input.type], settings, 60 * 60 * 1000, input.refresh, async () => {
    if (input.provider === "free") {
      const data = await request("free", `/meta/${input.type}/${input.id}.json`, {}, settings), meta = object(data.meta);
      if (!Object.keys(meta).length) throw failure("metadata-not-found", 404);
      const candidate = freeCandidate(meta, input.type);
      if (!candidate || candidate.id !== input.id) throw failure("metadata-invalid-response", 502);
      const runtimeMatch = /^(?:(\d{1,2})\s*h)?\s*(?:(\d{1,3})\s*min)?$/i.exec(text(meta.runtime, 30)), runtime = runtimeMatch ? Number(runtimeMatch[1] ?? 0) * 60 + Number(runtimeMatch[2] ?? 0) : 0;
      const ratingText = text(meta.imdbRating, 10), rating = /^(?:\d(?:\.\d+)?|10(?:\.0+)?)$/.test(ratingText) ? Number(ratingText) : null;
      return { ...candidate, genres: strings(meta.genres, 20, 80), backdropUrl: freeImage(meta.background), cast: strings(meta.cast, 16, 120),
        runtimeMinutes: runtime > 0 && runtime <= 1440 ? runtime : null, rating: rating !== null && rating <= 10 ? rating : null, ratingSource: rating !== null && rating <= 10 ? "IMDb" : null,
        contentRating: null, imdbId: candidate.id, tmdbId: null, providerUrl: `https://www.imdb.com/title/${candidate.id}/`, fetchedAt: new Date().toISOString() };
    }
    if (input.provider === "tmdb") {
      const data = await request("tmdb", `/${input.type === "movie" ? "movie" : "tv"}/${input.id}`, { language: settings.language, append_to_response: input.type === "movie" ? "credits,external_ids,release_dates" : "credits,external_ids,content_ratings" }, settings);
      const candidate = tmdbCandidate(data, input.type);
      if (!candidate || candidate.id !== input.id) throw failure("metadata-invalid-response", 502);
      const credits = object(data.credits), externals = object(data.external_ids);
      const performers = Array.isArray(credits.cast) ? credits.cast.slice(0, 16).map(value => object(value).name) : [];
      const runtime = input.type === "movie" ? number(data.runtime) : Array.isArray(data.episode_run_time) ? number(data.episode_run_time[0]) : null;
      const rating = number(data.vote_average), votes = number(data.vote_count), rated = rating !== null && rating >= 0 && rating <= 10 && votes !== null && votes > 0;
      const releases = object(data[input.type === "movie" ? "release_dates" : "content_ratings"]);
      const certifications = Array.isArray(releases.results) ? releases.results.map(object) : [];
      const local = certifications.find(item => item.iso_3166_1 === settings.language.slice(-2)) ?? certifications.find(item => item.iso_3166_1 === "US");
      const certificates = input.type === "movie" && Array.isArray(local?.release_dates) ? local.release_dates.map(value => text(object(value).certification, 50)).filter(Boolean) : [];
      return { ...candidate, genres: strings(Array.isArray(data.genres) ? data.genres.map(value => object(value).name) : [], 20, 80),
        backdropUrl: image(data.backdrop_path, "w1280"), cast: strings(performers, 16, 120), runtimeMinutes: runtime !== null && runtime > 0 && runtime <= 1440 ? Math.round(runtime) : null,
        rating: rated ? Math.round(rating * 10) / 10 : null, ratingSource: rated ? "TMDB" : null,
        contentRating: input.type === "movie" ? certificates[0] ?? null : text(local?.rating, 50) || null,
        imdbId: imdbId(externals.imdb_id) ?? imdbId(data.imdb_id), tmdbId: candidate.id,
        providerUrl: `https://www.themoviedb.org/${input.type === "movie" ? "movie" : "tv"}/${candidate.id}`, fetchedAt: new Date().toISOString() };
    }
    const data = await request("omdb", "", { i: input.id, type: input.type, plot: "full" }, settings), candidate = omdbCandidate(data, input.type);
    if (!candidate || candidate.id !== input.id) throw failure("metadata-invalid-response", 502);
    const runtimeMatch = /^(\d+) min$/.exec(text(data.Runtime, 30)), runtime = runtimeMatch ? Number(runtimeMatch[1]) : 0;
    const ratingText = text(data.imdbRating, 10), rating = /^(?:\d(?:\.\d+)?|10(?:\.0+)?)$/.test(ratingText) ? Number(ratingText) : null;
    return { ...candidate, genres: strings(text(data.Genre, 2000).split(","), 20, 80), backdropUrl: null,
      cast: strings(text(data.Actors, 3000).split(","), 16, 120), runtimeMinutes: runtime > 0 && runtime <= 1440 ? runtime : null,
      rating: rating !== null && rating >= 0 && rating <= 10 ? rating : null, ratingSource: rating !== null && rating >= 0 && rating <= 10 ? "IMDb" : null,
      contentRating: text(data.Rated, 50) || null, imdbId: candidate.id, tmdbId: null,
      providerUrl: `https://www.imdb.com/title/${candidate.id}/`, fetchedAt: new Date().toISOString() };
  });
}
/** OMDb has no authentication endpoint, and the built-in source has no key; both are tested with one public title lookup. */
/** A trailer's YouTube id from TMDB, when a TMDB key is configured (the administrator's, or the project's shared one); null otherwise. */
export async function tmdbTrailer(imdb: string, type: MediaType, settings?: MetadataSettings): Promise<string | null> {
  const current = settings ?? await getMetadataSettings();
  if (!providerCredential(current, "tmdb") || !/^tt\d{7,10}$/.test(imdb)) return null;
  try {
    const found = await request("tmdb", `/find/${imdb}`, { external_source: "imdb_id" }, current);
    const first = object((Array.isArray(found[type === "movie" ? "movie_results" : "tv_results"]) ? found[type === "movie" ? "movie_results" : "tv_results"] as unknown[] : [])[0]), id = tmdbId(first.id);
    if (!id) return null;
    const videos = await request("tmdb", `/${type === "movie" ? "movie" : "tv"}/${id}/videos`, {}, current);
    const list = (Array.isArray(videos.results) ? videos.results as unknown[] : []).map(object).filter(video => video.site === "YouTube" && typeof video.key === "string" && /^[A-Za-z0-9_-]{11}$/.test(video.key));
    const pick = list.find(video => video.type === "Trailer" && video.official === true) ?? list.find(video => video.type === "Trailer") ?? list.find(video => video.type === "Teaser");
    return pick ? String(pick.key) : null;
  } catch { return null; }
}
export async function testMetadataProvider(provider: MetadataProvider, settings?: MetadataSettings): Promise<void> {
  settings ??= await getMetadataSettings();
  validProvider(provider);
  if (provider === "tmdb") { const data = await request("tmdb", "/authentication", {}, settings); if (data.success !== true) throw failure("metadata-invalid-response", 502); }
  else await fetchMetadata({ provider, id: "tt0109830", type: "movie", refresh: true }, settings);
}
