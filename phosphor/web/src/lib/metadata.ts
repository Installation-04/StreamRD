/** "free" is the built-in source: no account or API key needed. */
export type MetadataProvider = "tmdb" | "omdb" | "free";
export type MetadataType = "movie" | "series";
export type MetadataTarget = { type: "catalog" | "library" | "account"; id: string };
export interface MetadataCandidate {
  provider: MetadataProvider;
  id: string;
  type: MetadataType;
  name: string;
  year: number | null;
  posterUrl: string | null;
  description: string;
}
export interface MetadataDetails extends MetadataCandidate {
  genres: string[];
  backdropUrl: string | null;
  cast: string[];
  runtimeMinutes: number | null;
  rating: number | null;
  ratingSource: string | null;
  contentRating: string | null;
  imdbId: string | null;
  tmdbId: string | null;
  providerUrl: string;
  fetchedAt: string;
}
export interface MetadataSettings {
  provider: MetadataProvider;
  /** The source actually used: the chosen provider when it has a key, otherwise the built-in one. */
  activeProvider: MetadataProvider;
  /** True when this server was deployed with a shared TMDB key (never exposed). */
  projectTmdbKey: boolean;
  language: string;
  automatic: boolean;
  refreshDays: number;
  tmdbConfigured: boolean;
  omdbConfigured: boolean;
}
export type MetadataState = "queued" | "processing" | "matched" | "review" | "unmatched" | "error";
export interface MetadataRecord {
  id: string;
  targetType: "catalog" | "library" | "account";
  targetId: string;
  name: string;
  mediaType: MetadataType;
  year: number | null;
  status: MetadataState;
  data: MetadataDetails | null;
  lockedFields: string[];
  revision: number;
  error: string | null;
  updatedAt: string;
  attempts: number;
}
export type MetadataSummary = Record<MetadataState, number>;
export const METADATA_FIELDS = ["name", "year", "description", "genres", "posterUrl", "backdropUrl"] as const;
export const METADATA_LABELS: Record<typeof METADATA_FIELDS[number], string> = {
  name: "Title", year: "Year", description: "Overview", genres: "Genres", posterUrl: "Poster", backdropUrl: "Backdrop",
};
export const PROVIDER_LABELS: Record<MetadataProvider, string> = { tmdb: "TMDB", omdb: "OMDb / IMDb", free: "Built-in (no account)" };
export function imdbLink(id: string | null | undefined): string | null {
  return id && /^tt\d{7,12}$/.test(id) ? `https://www.imdb.com/title/${id}/` : null;
}
export function metadataSourceLink(data: MetadataDetails): string | null {
  try {
    const url = new URL(data.providerUrl);
    return url.protocol === "https:" && ["www.themoviedb.org", "www.imdb.com", "www.omdbapi.com", "omdbapi.com"].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
