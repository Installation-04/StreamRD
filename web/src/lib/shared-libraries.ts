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
  createdAt: string;
  updatedAt: string;
  users: LibraryMember[];
}
export interface SharedLibraryItems { items: AccountMedia[]; total: number; nextCursor: string | null }
export const libraryTypeLabel = (type: SharedLibrary["mediaType"]) => type === "movie" ? "Movies" : type === "series" ? "Series" : "Movies & series";
export interface SharedContinueItem { libraryId: string; item: AccountMedia; positionSeconds: number; durationSeconds: number; updatedAt: string }
