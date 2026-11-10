import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchMetadata } from "../src/metadata/providers";
import { DEFAULT_METADATA_SETTINGS, activeProvider, projectTmdbKey, providerCredential, publicMetadataSettings } from "../src/metadata/settings";

// A shared TMDB key can be supplied by the operator (TMDB_DEFAULT_API_KEY). It must only fill in when no key is saved,
// must never be returned to a browser, and must never be used for the built-in or OMDb sources.
const SHARED = "0123456789abcdef0123456789abcdef", OWN = "fedcba9876543210fedcba9876543210";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let urls: URL[];
beforeEach(() => { urls = []; vi.stubGlobal("fetch", vi.fn(async (input: unknown) => { urls.push(new URL(String(input))); return json({ results: [] }); })); });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.TMDB_DEFAULT_API_KEY; });

describe("a shared TMDB key supplied by the operator", () => {
  it("is ignored unless it looks like a TMDB key, and accepts a Bearer-prefixed token", () => {
    expect(projectTmdbKey()).toBe("");
    for (const bad of ["", "   ", "short", "has space inside the key value!!", "a".repeat(2000)]) { process.env.TMDB_DEFAULT_API_KEY = bad; expect(projectTmdbKey()).toBe(""); }
    process.env.TMDB_DEFAULT_API_KEY = `  Bearer ${SHARED} `; expect(projectTmdbKey()).toBe(SHARED);
  });
  it("makes TMDB the active source, but only until the administrator saves a key of their own", () => {
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS })).toBe("free");
    process.env.TMDB_DEFAULT_API_KEY = SHARED;
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS })).toBe("tmdb");
    expect(providerCredential({ ...DEFAULT_METADATA_SETTINGS }, "tmdb")).toBe(SHARED);
    expect(providerCredential({ ...DEFAULT_METADATA_SETTINGS, tmdbApiKey: OWN }, "tmdb")).toBe(OWN);
    // The shared key never leaks into the other sources, and an explicit choice of another source is respected.
    expect(providerCredential({ ...DEFAULT_METADATA_SETTINGS }, "omdb")).toBe("");
    expect(providerCredential({ ...DEFAULT_METADATA_SETTINGS }, "free")).toBe("built-in");
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS, provider: "free" })).toBe("free");
    expect(activeProvider({ ...DEFAULT_METADATA_SETTINGS, provider: "omdb" })).toBe("free");
  });
  it("is the credential used for requests only when no key is saved, and is never exposed in settings", async () => {
    process.env.TMDB_DEFAULT_API_KEY = SHARED;
    await searchMetadata({ query: "Sintel", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS });
    expect(urls[0].hostname).toBe("api.themoviedb.org"); expect(urls[0].searchParams.get("api_key")).toBe(SHARED);
    urls.length = 0;
    await searchMetadata({ query: "Sintel", type: "movie" }, { ...DEFAULT_METADATA_SETTINGS, tmdbApiKey: OWN });
    expect(urls[0].searchParams.get("api_key")).toBe(OWN);
    const exposed = publicMetadataSettings({ ...DEFAULT_METADATA_SETTINGS });
    expect(exposed).toMatchObject({ projectTmdbKey: true, tmdbConfigured: false, activeProvider: "tmdb" });
    expect(JSON.stringify(exposed)).not.toContain(SHARED);
  });
});
