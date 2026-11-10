import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { fetchMetadata, MetadataError, searchMetadata, testMetadataProvider } from "../src/metadata/providers";
import { DEFAULT_METADATA_SETTINGS, getMetadataSettings, METADATA_SETTINGS_KEY, publicMetadataSettings, saveMetadataSettings } from "../src/metadata/settings";
import { MetadataSettings } from "../src/metadata/types";

let serial = 0;
const settings = (patch: Partial<MetadataSettings> = {}): MetadataSettings => ({ ...DEFAULT_METADATA_SETTINGS, tmdbApiKey: `fixture-tmdb-${++serial}`, omdbApiKey: `fixture-omdb-${serial}`, ...patch });
const movie = { id: 123, title: "Fixture Movie", release_date: "2020-04-01", poster_path: "/fixture.jpg", overview: "A public metadata fixture." };
const omdb = { Response: "True", imdbID: "tt0109830", Title: "Fixture Movie", Type: "movie", Year: "2020", Plot: "A fixture.", Genre: "Drama, Comedy", Actors: "First Actor, Second Actor", Runtime: "123 min", imdbRating: "8.2", Rated: "PG", Poster: "https://m.media-amazon.com/images/fixture.jpg" };
const json = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
function respond(value: unknown, status = 200) { const mock = vi.fn().mockImplementation(() => Promise.resolve(json(value, status))); vi.stubGlobal("fetch", mock); return mock; }
beforeEach(async () => { await db.setting.deleteMany({ where: { key: METADATA_SETTINGS_KEY } }); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected upstream call"))); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("private metadata settings", () => {
  it("defaults to disabled automation and returns only credential-presence flags", async () => {
    const defaults = await getMetadataSettings(); expect(defaults).toEqual(DEFAULT_METADATA_SETTINGS);
    await saveMetadataSettings({ tmdbApiKey: "Bearer fixture-private-token", omdbApiKey: "private-omdb-token" });
    const current = await getMetadataSettings(); expect(current.tmdbApiKey).toBe("fixture-private-token");
    expect(publicMetadataSettings(current)).toEqual({ provider: "tmdb", activeProvider: "tmdb", projectTmdbKey: false, automatic: false, language: "en-US", refreshDays: 30, tmdbConfigured: true, omdbConfigured: true });
    expect(JSON.stringify(publicMetadataSettings(current))).not.toContain("private"); expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves omitted or blank keys and clears credentials only explicitly", async () => {
    await saveMetadataSettings({ tmdbApiKey: "first-key", omdbApiKey: "second-key", language: "fr-CA" });
    await saveMetadataSettings({ tmdbApiKey: "  ", refreshDays: 7 });
    expect(await getMetadataSettings()).toMatchObject({ tmdbApiKey: "first-key", omdbApiKey: "second-key", language: "fr-CA", refreshDays: 7 });
    await saveMetadataSettings({ clearTmdb: true }); expect((await getMetadataSettings()).tmdbApiKey).toBe("");
    expect((await getMetadataSettings()).omdbApiKey).toBe("second-key");
  });
  it("preserves independent partial settings saved concurrently", async () => {
    await Promise.all([
      saveMetadataSettings({ tmdbApiKey: "concurrent-key" }),
      saveMetadataSettings({ language: "fr-CA", refreshDays: 7 }),
    ]);
    expect(await getMetadataSettings()).toMatchObject({ tmdbApiKey: "concurrent-key", language: "fr-CA", refreshDays: 7 });
  });
  it("does not restore cleared credentials when another settings field is saved concurrently", async () => {
    await saveMetadataSettings({ tmdbApiKey: "must-stay-cleared", omdbApiKey: "preserve-this-key" });
    await Promise.all([
      saveMetadataSettings({ clearTmdb: true }),
      saveMetadataSettings({ language: "de-DE" }),
    ]);
    expect(await getMetadataSettings()).toMatchObject({ tmdbApiKey: "", omdbApiKey: "preserve-this-key", language: "de-DE" });
  });
  it("needs no key to enable automation: a provider without a key falls back to the built-in source", async () => {
    await saveMetadataSettings({ automatic: true });
    expect(await getMetadataSettings()).toMatchObject({ automatic: true, provider: "tmdb", tmdbApiKey: "" });
    await saveMetadataSettings({ tmdbApiKey: "saved-key" });
    await saveMetadataSettings({ provider: "omdb" }); // no OMDb key: lookups use the built-in source rather than failing
    expect(await getMetadataSettings()).toMatchObject({ automatic: true, provider: "omdb", tmdbApiKey: "saved-key", omdbApiKey: "" });
    await saveMetadataSettings({ provider: "tmdb", clearTmdb: true });
    expect(await getMetadataSettings()).toMatchObject({ automatic: true, provider: "tmdb", tmdbApiKey: "" });
  });
  it("rejects malformed patches and sanitizes unsupported persisted fields", async () => {
    for (const patch of [{ provider: "unknown" }, { refreshDays: 0 }, { language: "invalid" }, { tmdbApiKey: "key\nsecret" }, { unsupported: "private" }]) {
      await expect(saveMetadataSettings(patch as never)).rejects.toBeInstanceOf(MetadataError);
    }
    await db.setting.create({ data: { key: METADATA_SETTINGS_KEY, value: JSON.stringify({ provider: "unknown", automatic: "true", language: 123, tmdbApiKey: [], unsupported: "private" }) } });
    expect(await getMetadataSettings()).toEqual(DEFAULT_METADATA_SETTINGS);
    await db.setting.update({ where: { key: METADATA_SETTINGS_KEY }, data: { value: "malformed" } });
    expect(await getMetadataSettings()).toEqual(DEFAULT_METADATA_SETTINGS);
  });
});

describe("metadata provider protocol", () => {
  it("makes no requests without credentials or for invalid identity input", async () => {
    await expect(searchMetadata({ query: "Film", type: "movie", provider: "tmdb" }, { ...DEFAULT_METADATA_SETTINGS })).rejects.toMatchObject({ code: "metadata-not-configured", status: 503 }); // naming a keyed provider still needs its key
    await expect(fetchMetadata({ provider: "tmdb", id: "../../authentication", type: "movie" }, settings())).rejects.toMatchObject({ status: 400 });
    await expect(searchMetadata({ query: "x", type: "movie", year: 12 }, settings())).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("searches TMDB with a bearer token, locale/year filters, safe artwork and bounded results", async () => {
    const cfg = settings(), mock = respond({ results: [movie, { ...movie, id: 0 }, { ...movie, id: 4, adult: true }, { ...movie, id: 5, poster_path: "https://private.invalid/a.jpg" }] });
    const list = await searchMetadata({ query: "Film & Friends", type: "movie", year: 2020 }, cfg);
    expect(list).toHaveLength(2); expect(list[0]).toMatchObject({ provider: "tmdb", id: "123", year: 2020, posterUrl: "https://image.tmdb.org/t/p/w500/fixture.jpg" }); expect(list[1].posterUrl).toBeNull();
    const [value, init] = mock.mock.calls[0], url = new URL(String(value));
    expect(url.origin).toBe("https://api.themoviedb.org"); expect(url.pathname).toBe("/3/search/movie");
    expect(url.searchParams.get("query")).toBe("Film & Friends"); expect(url.searchParams.get("year")).toBe("2020"); expect(url.searchParams.get("include_adult")).toBe("false"); expect(url.searchParams.get("language")).toBe("en-US");
    expect(init).toMatchObject({ redirect: "error", headers: { Authorization: `Bearer ${cfg.tmdbApiKey}` } }); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(list)).not.toContain(cfg.tmdbApiKey);
  });
  it("supports v3 keys and TV first-air-date filtering", async () => {
    const cfg = settings({ tmdbApiKey: "a".repeat(32), language: "fr-CA" }), mock = respond({ results: [{ id: 12, name: "Series Fixture", first_air_date: "2019-01-01", poster_path: null }] });
    expect(await searchMetadata({ query: "Series", type: "series", year: 2019 }, cfg)).toMatchObject([{ id: "12", type: "series", name: "Series Fixture", year: 2019 }]);
    const url = new URL(String(mock.mock.calls[0][0])); expect(url.pathname).toBe("/3/search/tv"); expect(url.searchParams.get("first_air_date_year")).toBe("2019"); expect(url.searchParams.get("api_key")).toBe(cfg.tmdbApiKey); expect(url.searchParams.get("language")).toBe("fr-CA");
  });
  it("finds TMDB identities by IMDb ID and keeps movie and series results separate", async () => {
    const cfg = settings(), mock = respond({ movie_results: [movie], tv_results: [{ id: 44, name: "TV fixture" }] });
    expect(await searchMetadata({ query: "tt0109830", type: "movie" }, cfg)).toMatchObject([{ id: "123", type: "movie" }]);
    const url = new URL(String(mock.mock.calls[0][0])); expect(url.pathname).toBe("/3/find/tt0109830"); expect(url.searchParams.get("external_source")).toBe("imdb_id");
  });
  it("uses OMDb type/year search parameters and filters malformed or episode results", async () => {
    const cfg = settings({ provider: "omdb" }), mock = respond({ Response: "True", Search: [omdb, { ...omdb, Type: "episode" }, { ...omdb, imdbID: "bad" }] });
    const list = await searchMetadata({ query: "Fixture", type: "movie", year: 2020 }, cfg); expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ id: "tt0109830", year: 2020 });
    const url = new URL(String(mock.mock.calls[0][0])); expect(url.origin).toBe("https://www.omdbapi.com"); expect(url.searchParams.get("apikey")).toBe(cfg.omdbApiKey); expect(url.searchParams.get("s")).toBe("Fixture"); expect(url.searchParams.get("type")).toBe("movie"); expect(url.searchParams.get("y")).toBe("2020"); expect(JSON.stringify(list)).not.toContain(cfg.omdbApiKey);
  });
  it("looks up an IMDb identifier directly through OMDb", async () => {
    const mock = respond(omdb); expect(await searchMetadata({ query: "tt0109830", type: "movie", provider: "omdb" }, settings())).toMatchObject([{ id: "tt0109830", description: "A fixture." }]);
    expect(new URL(String(mock.mock.calls[0][0])).searchParams.get("i")).toBe("tt0109830");
  });
  it("normalizes TMDB movie details, cast, images, provenance, IMDb identity and local certification", async () => {
    const mock = respond({ ...movie, genres: [{ name: "Drama" }], backdrop_path: "/backdrop.jpg", runtime: 110, vote_average: 7.64, vote_count: 20, credits: { cast: [{ name: "Actor One" }, { name: "Actor One" }, { name: "Actor Two" }] }, external_ids: { imdb_id: "tt0109830" }, release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] }, { iso_3166_1: "CA", release_dates: [{ certification: "14A" }] }] } });
    const details = await fetchMetadata({ provider: "tmdb", id: "123", type: "movie" }, settings({ language: "en-CA" }));
    expect(details).toMatchObject({ genres: ["Drama"], backdropUrl: "https://image.tmdb.org/t/p/w1280/backdrop.jpg", runtimeMinutes: 110, cast: ["Actor One", "Actor Two"], rating: 7.6, ratingSource: "TMDB", contentRating: "14A", imdbId: "tt0109830", tmdbId: "123", providerUrl: "https://www.themoviedb.org/movie/123" }); expect(Number.isNaN(Date.parse(details.fetchedAt))).toBe(false);
    expect(new URL(String(mock.mock.calls[0][0])).searchParams.get("append_to_response")).toContain("external_ids");
  });
  it("normalizes series runtimes and omits unvoted ratings instead of fabricating zero scores", async () => {
    respond({ id: 55, name: "Series fixture", first_air_date: "2018-04-01", episode_run_time: [42], vote_average: 0, vote_count: 0, content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-14" }] } });
    expect(await fetchMetadata({ provider: "tmdb", id: "55", type: "series" }, settings())).toMatchObject({ runtimeMinutes: 42, rating: null, ratingSource: null, contentRating: "TV-14", providerUrl: "https://www.themoviedb.org/tv/55" });
  });
  it("normalizes OMDb IMDb ratings and rejects credentialed or private image URLs", async () => {
    respond({ ...omdb, Poster: "https://img.omdbapi.com/?apikey=private&i=tt0109830" });
    expect(await fetchMetadata({ provider: "omdb", id: "tt0109830", type: "movie" }, settings())).toMatchObject({ provider: "omdb", posterUrl: null, cast: ["First Actor", "Second Actor"], runtimeMinutes: 123, rating: 8.2, ratingSource: "IMDb", contentRating: "PG", genres: ["Drama", "Comedy"], imdbId: "tt0109830", tmdbId: null, providerUrl: "https://www.imdb.com/title/tt0109830/" });
  });
  it("keeps unavailable OMDb fields null and rejects mismatched detail identities", async () => {
    respond({ ...omdb, Poster: "N/A", Runtime: "N/A", imdbRating: "N/A", Rated: "N/A", Actors: "N/A", Genre: "N/A" });
    expect(await fetchMetadata({ provider: "omdb", id: "tt0109830", type: "movie" }, settings())).toMatchObject({ posterUrl: null, runtimeMinutes: null, rating: null, ratingSource: null, contentRating: null, genres: [], cast: [] });
    respond(omdb); await expect(fetchMetadata({ provider: "omdb", id: "tt0123456", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-invalid-response" });
  });
  it.each([[401, "metadata-authentication-failed", 502], [403, "metadata-authentication-failed", 502], [429, "metadata-rate-limited", 429], [503, "metadata-unavailable", 503]])("sanitizes HTTP %i failures", async (status, code, returned) => {
    const cfg = settings(); respond({ error: `secret=${cfg.tmdbApiKey}`, privatePath: "/private/volume" }, status as number);
    const error = await searchMetadata({ query: "Fixture", type: "movie" }, cfg).catch(error => error);
    expect(error).toMatchObject({ code, status: returned }); expect(error.message).not.toContain(cfg.tmdbApiKey); expect(error.message).not.toContain("private");
  });
  it("distinguishes OMDb unmatched titles from invalid credentials and exhausted quotas", async () => {
    respond({ Response: "False", Error: "Movie not found!" }); expect(await searchMetadata({ provider: "omdb", query: "Unmatched", type: "movie" }, settings())).toEqual([]);
    respond({ Response: "False", Error: "Invalid API key! secret=private" }); await expect(searchMetadata({ provider: "omdb", query: "Fixture", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-authentication-failed", status: 502 });
    respond({ Response: "False", Error: "Request limit reached!" }); await expect(searchMetadata({ provider: "omdb", query: "Fixture", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-rate-limited", status: 429 });
    respond({ Response: "False", Error: "Too many results." }); await expect(searchMetadata({ provider: "omdb", query: "Fixture", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-query-too-broad", status: 400 });
  });
  it("sanitizes fetch and malformed JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("https://www.omdbapi.com/?apikey=private")));
    await expect(searchMetadata({ query: "Fixture", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-unavailable", message: "The metadata provider is unavailable; try again later." });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json secret=private")));
    await expect(searchMetadata({ query: "Fixture", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-unavailable" });
  });
  it("enforces response-size limits for both declared and streamed payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 200, { "content-length": String(2 * 1024 * 1024) })));
    await expect(searchMetadata({ query: "Large", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-invalid-response", status: 502 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" ".repeat(1024 * 1024 + 1))));
    await expect(searchMetadata({ query: "Large", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-invalid-response", status: 502 });
  });
  it("aborts timed-out calls and emits a generic provider error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("private timeout"))))));
    const assertion = expect(searchMetadata({ query: "Timeout", type: "movie" }, settings())).rejects.toMatchObject({ code: "metadata-unavailable", status: 503 });
    await vi.advanceTimersByTimeAsync(8001); await assertion;
  });
  it("uses distinct provider connectivity tests and always refreshes the OMDb test lookup", async () => {
    let mock = respond({ success: true }); await testMetadataProvider("tmdb", settings()); expect(new URL(String(mock.mock.calls[0][0])).pathname).toBe("/3/authentication");
    mock = respond(omdb); const cfg = settings(); await testMetadataProvider("omdb", cfg); await testMetadataProvider("omdb", cfg); expect(mock).toHaveBeenCalledTimes(2); expect(new URL(String(mock.mock.calls[0][0])).searchParams.get("i")).toBe("tt0109830");
  });
});

describe("bounded metadata request/cache behavior", () => {
  it("singleflights duplicate searches and returns independent cached values", async () => {
    const mock = respond({ results: [movie] }), cfg = settings();
    const [first, second] = await Promise.all([searchMetadata({ query: "Together", type: "movie" }, cfg), searchMetadata({ query: "Together", type: "movie" }, cfg)]);
    expect(mock).toHaveBeenCalledTimes(1); first[0].name = "Changed locally"; expect(second[0].name).toBe("Fixture Movie");
    expect((await searchMetadata({ query: "Together", type: "movie" }, cfg))[0].name).toBe("Fixture Movie"); expect(mock).toHaveBeenCalledTimes(1);
  });
  it("partitions cache by credentials and locale and allows forced refresh", async () => {
    const mock = respond({ results: [movie] }), cfg = settings(), input = { query: "Partition", type: "movie" as const };
    await searchMetadata(input, cfg); await searchMetadata(input, { ...cfg, language: "fr-CA" }); await searchMetadata(input, { ...cfg, tmdbApiKey: "rotated-key" }); await searchMetadata({ ...input, refresh: true }, cfg); expect(mock).toHaveBeenCalledTimes(4);
  });
  it("evicts old cache entries at its fixed capacity", async () => {
    const mock = respond({ results: [movie] }), cfg = settings();
    for (let index = 0; index < 201; index++) await searchMetadata({ query: `Bounded-${index}`, type: "movie" }, cfg);
    await searchMetadata({ query: "Bounded-0", type: "movie" }, cfg); expect(mock).toHaveBeenCalledTimes(202);
  });
  it("limits upstream concurrency and rejects excess distinct-key work instead of growing queues", async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; }); let running = 0, maximum = 0;
    const mock = vi.fn().mockImplementation(async () => { running++; maximum = Math.max(maximum, running); await gate; running--; return json({ results: [movie] }); }); vi.stubGlobal("fetch", mock);
    const cfg = settings(), calls = Array.from({ length: 23 }, (_, index) => searchMetadata({ query: `Concurrent-${index}`, type: "movie" }, cfg));
    const completion = Promise.allSettled(calls); await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2)); open(); const results = await completion;
    expect(maximum).toBe(2); expect(results.filter(value => value.status === "fulfilled")).toHaveLength(22);
    const rejected = results.find(value => value.status === "rejected") as PromiseRejectedResult; expect(rejected.reason).toMatchObject({ code: "metadata-busy", status: 429 });
  });
});
