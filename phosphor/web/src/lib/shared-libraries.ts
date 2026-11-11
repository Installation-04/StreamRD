import type { AccountMedia } from "./account-library";

export interface SharedLibrary {
  id: string;
  name: string;
  mediaType: "all" | "movie" | "series";
  itemCount: number;
}
export interface LibraryMember { id: string; email: string; displayName: string; active: boolean }
export interface ManagedSharedLibrary extends SharedLibrary {
  enabled: boolean;
  everyone: boolean;
  createdAt: string;
  updatedAt: string;
  users: LibraryMember[];
}
/** `attention` is sent to the administrator only: titles whose match needs a decision, and titles whose link stopped working. */
export interface SharedLibraryItems { items: AccountMedia[]; total: number; nextCursor: string | null; attention?: { match: number; links: number } }
export const libraryTypeLabel = (type: SharedLibrary["mediaType"]) => type === "movie" ? "Movies" : type === "series" ? "TV shows" : "Movies & TV shows";
/** One of several copies of the same title (for example 1080p and 4K); the page offers a choice when there is more than one. */
export interface TitleVersion { id: string; quality: string | null; release: string | null; phase: "queued" | "downloading" | "finished" | "error"; createdAt: string; current: boolean }
