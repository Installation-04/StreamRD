import type { AccountMedia } from "./account-library";

export interface ExternalCard { provider: "free"; id: string; type: "movie" | "series"; name: string; year: number | null; posterUrl: string | null; rating: number | null }
/** libraryId is null for an administrator's own import that is not in any library yet. */
export interface LibraryCard { libraryId: string | null; item: AccountMedia }
/** One slide of the home banner. `trailer` is a YouTube video id (played only after the viewer opts in) or null. */
export interface Slide { kind: "library" | "external"; id: string; href: string; title: string; year: number | null; rating: number | null; genres: string[]; description: string; backdropUrl: string; trailer: string | null; label: string }
export interface HomeData {
  externalEnabled: boolean;
  trailersEnabled: boolean;
  featured: Slide[];
  recentlyAdded: LibraryCard[];
  myList?: LibraryCard[];
  popularHere: LibraryCard[];
  trending: ExternalCard[];
  popularMovies: ExternalCard[];
  popularSeries: ExternalCard[];
}
