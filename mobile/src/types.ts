export interface User {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
}

export interface Title {
  id: string;
  name: string;
  description: string;
  type: "movie" | "series";
  genres: string[];
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  sourceCount: number;
}

export interface CatalogRow {
  id: string;
  label: string;
  titles: Title[];
}

export interface StreamInfo {
  url: string;
  filename: string;
  provider: string;
  quality?: string;
}

export type Screen =
  | { name: "login" }
  | { name: "home" }
  | { name: "title"; id: string }
  | { name: "player"; id: string }
  | { name: "settings" }
  | { name: "admin" };
