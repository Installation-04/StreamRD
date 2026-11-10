/** Public metadata shapes contain no API credentials or provider response bodies. */
/** "free" is the built-in source that needs no account or key (Cinemeta, which serves IMDb data by IMDb ID). */
export type MetadataProvider = "tmdb" | "omdb" | "free";
export type MediaType = "movie" | "series";
export interface MetadataCandidate {
  provider: MetadataProvider;
  id: string;
  type: MediaType;
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
  language: string;
  automatic: boolean;
  refreshDays: number;
  tmdbApiKey: string;
  omdbApiKey: string;
}
export type PublicMetadataSettings = Omit<MetadataSettings, "tmdbApiKey" | "omdbApiKey"> & {
  /** The source actually used: the chosen provider when it has a key, otherwise the built-in one. */
  activeProvider: MetadataProvider;
  tmdbConfigured: boolean;
  omdbConfigured: boolean;
};
export class MetadataError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "MetadataError";
  }
}
