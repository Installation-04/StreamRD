import type { AccountMedia } from "./account-library";

export interface ExternalCard { provider: "free"; id: string; type: "movie" | "series"; name: string; year: number | null; posterUrl: string | null; rating: number | null }
/** libraryId is null for an administrator's own import that is not in any library yet. */
export interface LibraryCard { libraryId: string | null; item: AccountMedia }
export interface HomeData {
  externalEnabled: boolean;
  recentlyAdded: LibraryCard[];
  popularHere: LibraryCard[];
  trending: ExternalCard[];
  popularMovies: ExternalCard[];
  popularSeries: ExternalCard[];
}
