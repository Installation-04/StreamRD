import { db } from "./db";
import { PRODUCT } from "./product";
import { sharedMediaWhere, visibleSharedLibraryWhere } from "./shared-libraries";
import { accountMediaViews } from "./routes/account-library";
import { currentAccountMediaFilter } from "./account-library";
import { favoriteIds, favoriteItems } from "./favorites";

/**
 * The rows on the home page. Library rows (recently added, popular on this server) come from the libraries the viewer may
 * see. The "trending" and "popular" rows come from the public Cinemeta catalogues (no account, no key), fetched by the server and
 * cached, so a browser never contacts them and nothing about a viewer is sent. Set HOME_EXTERNAL_LISTS=false to turn them off.
 */
const HOSTS = new Set(["v3-cinemeta.strem.io", "cinemeta-catalogs.strem.io"]), POSTER_HOST = "images.metahub.space";
const FRESH_MS = 6 * 3600_000, STALE_MS = 7 * 86400_000, TIMEOUT_MS = 8000, MAX_BYTES = 4 * 1024 * 1024, ROW = 20;
export interface ExternalCard { provider: "free"; id: string; type: "movie" | "series"; name: string; year: number | null; posterUrl: string | null; rating: number | null }
type Ranked = ExternalCard & { trakt: number; backdrop: string | null; description: string; genres: string[]; trailer: string | null };
const cache = new Map<string, { at: number; cards: Ranked[] }>(), flights = new Map<string, Promise<Ranked[]>>();
export function resetHomeCache() { cache.clear(); flights.clear(); }
export const externalListsEnabled = () => process.env.HOME_EXTERNAL_LISTS?.trim().toLowerCase() !== "false";
/** Trailers are played by the viewer's browser from YouTube, and only after that viewer opts in; an operator can remove the option. */
export const trailersAvailable = () => externalListsEnabled() && process.env.HOME_TRAILERS?.trim().toLowerCase() !== "false";

async function getJson(href: string, hops = 2): Promise<unknown> {
  const url = new URL(href);
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new Error("blocked host");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref();
  try {
    // Redirects are followed by hand, only between the two allow-listed catalogue hosts.
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": `${PRODUCT.id}-home` }, redirect: "manual", signal: controller.signal });
    if ([301, 302, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || hops <= 0) throw new Error("bad redirect");
      return getJson(new URL(location, url).href, hops - 1);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("unavailable"); }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error("too large");
    return JSON.parse(bytes.toString("utf8"));
  } finally { clearTimeout(timer); }
}
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().replace(/[\u0000-\u001f]/g, "").slice(0, max) : "";
function poster(value: unknown): string | null {
  try { const url = new URL(text(value, 2000)); return url.protocol === "https:" && url.hostname === POSTER_HOST && !url.username && !url.password && !url.port && !url.search && !url.hash ? url.href : null; } catch { return null; }
}
const youtubeId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
function trailerOf(meta: Record<string, unknown>): string | null {
  for (const entry of Array.isArray(meta.trailers) ? meta.trailers : []) {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const id = item.type === undefined || item.type === "Trailer" ? youtubeId(item.source) : null; if (id) return id;
  }
  for (const entry of Array.isArray(meta.trailerStreams) ? meta.trailerStreams : []) { const id = youtubeId(entry && typeof entry === "object" ? (entry as Record<string, unknown>).ytId : null); if (id) return id; }
  return null;
}
function card(value: unknown, type: "movie" | "series"): Ranked | null {
  const meta = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const id = [meta.imdb_id, meta.id].find((candidate): candidate is string => typeof candidate === "string" && /^tt\d{7,10}$/.test(candidate)), name = text(meta.name, 300);
  if (!id || !name || (meta.type !== undefined && meta.type !== type)) return null;
  const yearMatch = /^(\d{4})/.exec(String(meta.year ?? meta.releaseInfo ?? "")), year = yearMatch && +yearMatch[1] >= 1800 && +yearMatch[1] <= 2200 ? +yearMatch[1] : null;
  const rating = /^(?:\d(?:\.\d+)?|10(?:\.0+)?)$/.test(text(meta.imdbRating, 10)) ? Number(meta.imdbRating) : null;
  const popularity = meta.popularities && typeof meta.popularities === "object" ? Number((meta.popularities as Record<string, unknown>).trakt) : 0;
  const genres = Array.isArray(meta.genres) ? [...new Set(meta.genres.map(genre => text(genre, 40)).filter(Boolean))].slice(0, 3) : [];
  return { provider: "free", id, type, name, year, posterUrl: poster(meta.poster), rating, trakt: Number.isFinite(popularity) ? popularity : 0,
    backdrop: poster(meta.background), description: text(meta.description, 280), genres, trailer: trailerOf(meta) };
}
/** One catalogue, cached; a failed refresh serves the last good copy for up to a week and otherwise nothing. */
async function catalogue(type: "movie" | "series"): Promise<Ranked[]> {
  const key = type, hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.cards;
  const running = flights.get(key); if (running) return running;
  const work = (async () => {
    try {
      const body = await getJson(`https://v3-cinemeta.strem.io/catalog/${type}/top.json`) as { metas?: unknown };
      if (!Array.isArray(body.metas)) throw new Error("unsupported response");
      const seen = new Set<string>(), cards = body.metas.slice(0, 100).map(meta => card(meta, type)).filter((entry): entry is Ranked => entry !== null && !seen.has(entry.id) && Boolean(seen.add(entry.id)));
      cache.set(key, { at: Date.now(), cards }); return cards;
    } catch {
      if (hit && Date.now() - hit.at < STALE_MS) { cache.set(key, { at: Date.now() - FRESH_MS + 5 * 60_000, cards: hit.cards }); return hit.cards; } // retry in five minutes
      return [];
    } finally { flights.delete(key); }
  })();
  flights.set(key, work); return work;
}
const strip = ({ trakt: _trakt, backdrop: _backdrop, description: _description, genres: _genres, trailer: _trailer, ...rest }: Ranked): ExternalCard => rest;
/** One slide of the home banner carousel. `trailer` is a YouTube video id or null. */
export interface Slide { kind: "library" | "external"; id: string; href: string; title: string; year: number | null; rating: number | null; genres: string[]; description: string; backdropUrl: string; trailer: string | null; label: string }
export async function externalSections() {
  if (!externalListsEnabled()) return { externalEnabled: false, trailersEnabled: false, trending: [] as ExternalCard[], popularMovies: [] as ExternalCard[], popularSeries: [] as ExternalCard[], featured: [] as Slide[] };
  const [movies, series] = await Promise.all([catalogue("movie"), catalogue("series")]);
  const trending = [...movies, ...series].sort((a, b) => b.trakt - a.trakt).slice(0, ROW);
  const featured = trending.filter(card => card.backdrop && card.description).slice(0, 6).map((card): Slide => ({ kind: "external", id: card.id, href: `/discover/free/${card.type}/${encodeURIComponent(card.id)}`, title: card.name, year: card.year, rating: card.rating,
    genres: card.genres, description: card.description, backdropUrl: card.backdrop!, trailer: trailersAvailable() ? card.trailer : null, label: "TRENDING NOW" }));
  return { externalEnabled: true, trailersEnabled: trailersAvailable(), trending: trending.map(strip), popularMovies: movies.slice(0, ROW).map(strip), popularSeries: series.slice(0, ROW).map(strip), featured };
}

/** Administrators also see what they imported themselves, even before they put it in a library. */
export async function librarySections(userId: string, role: string, limit: number | null = null) {
  const libraries = await db.sharedLibrary.findMany({ where: visibleSharedLibraryWhere(userId), orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
  const own = role === "admin" ? [{ AND: [{ userId }, await currentAccountMediaFilter(userId)] }] : [];
  if (!libraries.length && !own.length) return { recentlyAdded: [], popularHere: [], myList: [] as Array<{ libraryId: string; item: Awaited<ReturnType<typeof accountMediaViews>>[number] & { favorite: boolean } }>, libraryFeatured: [] as Slide[] };
  const where = { phase: "finished", OR: [...await Promise.all(libraries.map(library => sharedMediaWhere(library, limit))), ...own] };
  const libraryOf = (item: { userId: string; type: string }) => libraries.find(library => library.sourceUserId === item.userId && (library.mediaType === "all" || library.mediaType === item.type))?.id ?? null;
  const recent = await db.accountMedia.findMany({ where: { AND: [where, { isPrimary: true }] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: ROW });
  // Ranked by how many viewers resumed or finished a title in the last 30 days; only the ranking leaves the server, never who watched.
  const groups = await db.sharedLibraryProgress.groupBy({ by: ["itemId"], where: { updatedAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _count: { _all: true }, orderBy: [{ _count: { itemId: "desc" } }], take: 60 });
  const found = groups.length ? await db.accountMedia.findMany({ where: { AND: [where, { id: { in: groups.map(group => group.itemId) } }] } }) : [];
  const rank = new Map(groups.map((group, index) => [group.itemId, index])), popular = found.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).filter((item, index, all) => !item.groupKey || all.findIndex(other => other.userId === item.userId && other.groupKey === item.groupKey) === index).slice(0, 12);
  const [recentViews, popularViews] = await Promise.all([accountMediaViews(recent), accountMediaViews(popular)]);
  const marks = await favoriteIds(userId, [...recent, ...popular]);
  const recentlyAdded = recent.map((item, index) => ({ libraryId: libraryOf(item), item: { ...recentViews[index], favorite: marks.has(item.id) } }));
  const listed = await favoriteItems(userId, limit, ROW), listedViews = await accountMediaViews(listed.map(row => row.item));
  const myList = listed.map((row, index) => ({ libraryId: row.libraryId, item: { ...listedViews[index], favorite: true } }));
  // Titles of the viewer's own libraries that have a backdrop and a synopsis lead the banner.
  const featured = recentlyAdded.flatMap(({ libraryId, item }): Slide[] => {
    const details = item.metadata, backdrop = details?.backdropUrl;
    if (!details || !backdrop || !details.description) return [];
    return [{ kind: "library", id: item.id, href: libraryId ? `/shared-libraries/${encodeURIComponent(libraryId)}/${encodeURIComponent(item.id)}` : `/library/${encodeURIComponent(item.id)}`, title: details.name || item.name, year: details.year ?? item.year,
      rating: details.rating ?? null, genres: (details.genres ?? []).slice(0, 3), description: details.description.slice(0, 280), backdropUrl: backdrop, trailer: null, label: "NEW IN YOUR LIBRARIES" }];
  }).slice(0, 2);
  return { recentlyAdded, myList, popularHere: popular.map((item, index) => ({ libraryId: libraryOf(item), item: { ...popularViews[index], favorite: marks.has(item.id) } })), libraryFeatured: featured };
}
