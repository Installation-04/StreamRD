import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config";
import { db } from "../src/db";
import { mediaLibrary } from "../src/library-instance";
import { queueTarget, recordFor, runMetadataJob, storedMetadata } from "../src/metadata/automation";
import { fetchMetadata, searchMetadata } from "../src/metadata/providers";
import { DEFAULT_METADATA_SETTINGS, METADATA_SETTINGS_KEY, activeProvider, getMetadataSettings, publicMetadataSettings, saveMetadataSettings } from "../src/metadata/settings";
import { resetDb } from "./helpers";

// The built-in source (Cinemeta) needs no account or key. Every request here is answered by a stub, never the network.
const poster = (id: string, kind = "poster") => `https://images.metahub.space/${kind}/small/${id}/img`;
const bunny = { id: "tt1254207", imdb_id: "tt1254207", type: "movie", name: "Big Buck Bunny", year: "2008", poster: poster("tt1254207"), background: poster("tt1254207", "background"),
  description: "A large rabbit deals with three tiny bullies.", runtime: "10 min", genres: ["Animation", "Short", "Comedy"], cast: ["Fixture Voice"], imdbRating: "6.8" };
const hero = { id: "tt2245084", imdb_id: "tt2245084", type: "movie", name: "Big Hero 6", year: "2014", poster: poster("tt2245084"), description: "Another film." };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
// Wikidata stub: "Sintel" is a known item with an IMDb ID; anything else is unknown. Replace to simulate failures.
const defaultWikidata = (url: URL): Response => {
  const action = url.searchParams.get("action");
  if (action === "wbsearchentities") return json({ search: url.searchParams.get("search") === "Sintel" ? [{ id: "Q1" }, { id: "Q2" }, { id: "bad id" }] : [] });
  return json({ entities: { Q1: { claims: { P345: [{ mainsnak: { datavalue: { value: "tt1727587" } } }] } }, Q2: { claims: { P345: [{ mainsnak: { datavalue: { value: "not-an-id" } } }] } } } });
};
let wikidata = defaultWikidata;
const sintel = { id: "tt1727587", imdb_id: "tt1727587", type: "movie", name: "Sintel", year: "2010", poster: poster("tt1727587") };
let calls: Array<{ url: URL; headers: Record<string, string> }>;
function cinemeta(handler: (url: URL) => Response | undefined = () => undefined) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.hostname === "www.wikidata.org") return wikidata(url);
    if (url.hostname !== "v3-cinemeta.strem.io") throw new Error(`Unexpected upstream host ${url.hostname}`);
    const custom = handler(url); if (custom) return custom;
    if (url.pathname.toLowerCase() === "/catalog/movie/top/search=big%20buck%20bunny.json") return json({ metas: [hero, bunny] });
    if (url.pathname === "/meta/movie/tt1254207.json") return json({ meta: bunny });
    if (url.pathname === "/meta/movie/tt1727587.json") return json({ meta: sintel });
    return json({ metas: [] });
  }));
}
beforeEach(async () => { wikidata = defaultWikidata; await db.setting.deleteMany({ where: { key: METADATA_SETTINGS_KEY } }); cinemeta(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the built-in metadata source", () => {
  it("searches by name with no key, no credentials in the request, and maps the results", async () => {
    const results = await searchMetadata({ query: "Big Buck Bunny", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(results.map(item => item.id)).toEqual(["tt2245084", "tt1254207"]);
    expect(results[1]).toMatchObject({ provider: "free", id: "tt1254207", type: "movie", name: "Big Buck Bunny", year: 2008, posterUrl: poster("tt1254207"), description: "A large rabbit deals with three tiny bullies." });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.search).toBe(""); expect(JSON.stringify(calls[0].headers)).not.toMatch(/authorization|apikey|api_key/i);
    expect(calls[0].headers["User-Agent"]).toMatch(/-metadata$/);
  });
  it("accepts only IMDb-keyed results of the right type and images from the poster host", async () => {
    cinemeta(url => url.pathname.startsWith("/catalog/") ? json({ metas: [
      { ...bunny, poster: "https://evil.example/poster.jpg", background: undefined }, { ...hero, type: "series" }, { id: "kitsu:1", name: "Not IMDb", type: "movie" }, { ...hero, name: "" },
      { ...hero, id: "tt0000001", imdb_id: "tt0000001", poster: "http://images.metahub.space/poster/small/tt1/img" }, { ...hero, id: "tt0000002", imdb_id: "tt0000002", year: undefined, releaseInfo: "2011–2019" },
    ] }) : undefined);
    const results = await searchMetadata({ query: "anything", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(results.map(item => [item.id, item.posterUrl, item.year])).toEqual([["tt1254207", null, 2008], ["tt0000001", null, 2014], ["tt0000002", poster("tt2245084"), 2011]]);
  });
  it("encodes the query into the request path and finds a title by its IMDb ID", async () => {
    await searchMetadata({ query: "Up / Down? .json", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(calls[0].url.pathname).toBe("/catalog/movie/top/search=Up%20%2F%20Down%3F%20.json.json");
    calls.length = 0;
    const byId = await searchMetadata({ query: "tt1254207", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(calls[0].url.pathname).toBe("/meta/movie/tt1254207.json"); expect(byId.map(item => item.id)).toEqual(["tt1254207"]);
  });
  it("reads full details, parsing runtime and rating defensively", async () => {
    const details = await fetchMetadata({ provider: "free", id: "tt1254207", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(details).toMatchObject({ provider: "free", id: "tt1254207", genres: ["Animation", "Short", "Comedy"], cast: ["Fixture Voice"], runtimeMinutes: 10, rating: 6.8, ratingSource: "IMDb",
      backdropUrl: poster("tt1254207", "background"), contentRating: null, imdbId: "tt1254207", tmdbId: null, providerUrl: "https://www.imdb.com/title/tt1254207/" });
    for (const [runtime, minutes] of [["1h 52min", 112], ["142 min", 142], ["N/A", null], ["", null], ["forever", null]] as const) {
      cinemeta(url => url.pathname === "/meta/movie/tt1254207.json" ? json({ meta: { ...bunny, runtime } }) : undefined);
      expect((await fetchMetadata({ provider: "free", id: "tt1254207", type: "movie", refresh: true }, { ...DEFAULT_METADATA_SETTINGS })).runtimeMinutes).toBe(minutes);
    }
    cinemeta(url => json({ meta: { ...bunny, imdbRating: "11.5", background: "https://evil.example/b.jpg" } }));
    expect(await fetchMetadata({ provider: "free", id: "tt1254207", type: "movie", refresh: true }, { ...DEFAULT_METADATA_SETTINGS })).toMatchObject({ rating: null, ratingSource: null, backdropUrl: null });
  });
  it("reports unknown titles, rate limits and bad responses without leaking upstream detail", async () => {
    cinemeta(() => json({}, 404));
    expect(await searchMetadata({ query: "Nothing", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS })).toEqual([]);
    await expect(fetchMetadata({ provider: "free", id: "tt1254207", type: "movie", refresh: true }, { ...DEFAULT_METADATA_SETTINGS })).rejects.toMatchObject({ code: "metadata-not-found", status: 404 });
    cinemeta(() => json({ meta: {} }));
    await expect(fetchMetadata({ provider: "free", id: "tt1254207", type: "movie", refresh: true }, { ...DEFAULT_METADATA_SETTINGS })).rejects.toMatchObject({ code: "metadata-not-found" });
    cinemeta(() => json({}, 429));
    await expect(searchMetadata({ query: "Slow", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS })).rejects.toMatchObject({ code: "metadata-rate-limited", status: 429 });
    cinemeta(() => new Response("<html>not json</html>", { status: 200 }));
    await expect(searchMetadata({ query: "Broken", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS })).rejects.toMatchObject({ code: "metadata-unavailable" });
    cinemeta(() => json({ nope: true }));
    await expect(searchMetadata({ query: "Odd", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS })).rejects.toMatchObject({ code: "metadata-invalid-response" });
  });
});

describe("the built-in source's second lookup", () => {
  it("finds a title the catalogue misses through its IMDb ID in Wikidata, and sends only the title", async () => {
    const results = await searchMetadata({ query: "Sintel", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ provider: "free", id: "tt1727587", name: "Sintel", year: 2010, posterUrl: poster("tt1727587") });
    const wiki = calls.filter(call => call.url.hostname === "www.wikidata.org");
    expect(wiki).toHaveLength(2); expect(wiki[0].url.searchParams.get("search")).toBe("Sintel");
    expect(wiki.every(call => !call.headers.Authorization && /-metadata$/.test(call.headers["User-Agent"]))).toBe(true);
  });
  it("puts the Wikidata match ahead of loosely related catalogue results", async () => {
    cinemeta(url => url.pathname.startsWith("/catalog/") ? json({ metas: [hero] }) : undefined);
    const results = await searchMetadata({ query: "Sintel", type: "movie", refresh: true }, { ...DEFAULT_METADATA_SETTINGS });
    expect(results.map(item => item.id)).toEqual(["tt1727587", "tt2245084"]);
  });
  it("is not used when a catalogue result is named exactly as typed, or for an IMDb ID", async () => {
    await searchMetadata({ query: "Big Buck Bunny", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    await searchMetadata({ query: "tt1254207", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(calls.some(call => call.url.hostname === "www.wikidata.org")).toBe(false);
  });
  it("returns nothing, not an error, when Wikidata knows nothing, fails or answers badly", async () => {
    expect(await searchMetadata({ query: "Unknown Title", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS })).toEqual([]);
    for (const [index, reply] of [() => json({}, 429), () => new Response("<html>", { status: 200 }), () => json({ search: "nope" })].entries()) {
      wikidata = reply; expect(await searchMetadata({ query: `Sintel ${index}`, type: "movie" }, { ...DEFAULT_METADATA_SETTINGS })).toEqual([]);
    }
  });
  it("keeps only IDs the catalogue knows as the requested type", async () => {
    expect(await searchMetadata({ query: "Sintel", type: "series" }, { ...DEFAULT_METADATA_SETTINGS })).toEqual([]);
  });
});

describe("falling back to the built-in source", () => {
  it("is used whenever the chosen provider has no key, and never when it does", async () => {
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS })).toBe("free");
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS, provider: "omdb" })).toBe("free");
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS, tmdbApiKey: "k" })).toBe("tmdb");
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS, provider: "free", tmdbApiKey: "k" })).toBe("free");
    vi.stubGlobal("fetch", vi.fn(async () => json({ results: [] })));
    await searchMetadata({ query: "Keyed", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS, tmdbApiKey: "a".repeat(32) });
    expect(String((vi.mocked(fetch).mock.calls[0] as unknown[])[0])).toContain("api.themoviedb.org");
  });
  it("lets automatic matching be switched on with no account and reports the active source", async () => {
    await saveMetadataSettings({ automatic: true });
    const settings = await getMetadataSettings();
    expect(settings).toMatchObject({ automatic: true, provider: "tmdb", tmdbApiKey: "", omdbApiKey: "" });
    expect(publicMetadataSettings(settings)).toMatchObject({ provider: "tmdb", activeProvider: "free", projectTmdbKey: false, automatic: true, tmdbConfigured: false, omdbConfigured: false });
    await saveMetadataSettings({ provider: "free" });
    expect((await getMetadataSettings()).provider).toBe("free");
  });
});

describe("automatic matching with the built-in source", () => {
  let temporary: string; const previous = [config.mediaSourceRoot, config.mediaLibraryRoot];
  beforeEach(async () => {
    await resetDb(); temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metadata-free-"));
    config.mediaSourceRoot = path.join(temporary, "source"); config.mediaLibraryRoot = path.join(temporary, "exports"); await fs.mkdir(config.mediaSourceRoot);
  });
  afterEach(async () => { [config.mediaSourceRoot, config.mediaLibraryRoot] = previous; await fs.rm(temporary, { recursive: true, force: true }); });
  it("matches a library file to the right title with no credentials saved", async () => {
    await saveMetadataSettings({ automatic: true });
    await fs.writeFile(path.join(config.mediaSourceRoot, "Big.Buck.Bunny.2008.mp4"), "fixture");
    const item = await mediaLibrary.add({ name: "Big Buck Bunny", year: 2008, type: "movie", sourcePath: "Big.Buck.Bunny.2008.mp4" });
    await queueTarget({ targetType: "library", targetId: item.id, name: item.media.name, mediaType: "movie", year: item.media.year ?? null }, false);
    expect(await runMetadataJob()).toBe(true);
    const record = await recordFor("library", item.id);
    expect(record).toMatchObject({ status: "matched" });
    expect(storedMetadata(record!.data)).toMatchObject({ provider: "free", id: "tt1254207", name: "Big Buck Bunny", posterUrl: poster("tt1254207"), imdbId: "tt1254207" });
    expect(calls.every(call => call.url.hostname === "v3-cinemeta.strem.io")).toBe(true);
  });
});
