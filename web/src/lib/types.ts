export type Role = "user" | "admin";

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  active: boolean;
  createdAt: string;
}

export interface Profile {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  preferences: string;
  createdAt: string;
}

export type ProviderId = "realdebrid" | "alldebrid" | "premiumize";
export const PROVIDER_IDS: ProviderId[] = ["realdebrid", "alldebrid", "premiumize"];
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  realdebrid: "Real-Debrid",
  alldebrid: "AllDebrid",
  premiumize: "Premiumize.me",
};

export interface TitleSource {
  kind: "link" | "magnet";
  url: string;
  quality?: string;
  label?: string;
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
  sources?: TitleSource[];
  createdAt: string;
}

export interface CatalogRow {
  id: string;
  label: string;
  titles: Title[];
}

export interface StreamInfo {
  url: string;
  filename: string;
  filesize?: number;
  mimeType?: string;
  provider: ProviderId;
  quality?: string;
  label?: string;
}

export interface DebridAccount {
  provider: ProviderId;
  username: string;
  email?: string;
  premium: boolean;
  premiumUntil?: string;
  points?: number;
}

export interface ServerSettings {
  providerOrder: ProviderId[];
  disabledProviders: ProviderId[];
  providerTimeoutMs: number;
  maxPlaybackAttempts: number;
  allowUnauthenticatedBrowse: boolean;
  requireLoginForPlayback: boolean;
}

export interface LogEntry {
  id: string;
  level: string;
  type: string;
  message: string;
  userId: string | null;
  provider: string | null;
  createdAt: string;
}

/** Compact fields needed to render a catalog card. */
export type TitleCardData = Pick<Title, "id" | "name" | "year" | "posterUrl"> & { positionSeconds?: number; durationSeconds?: number };
export interface BrowseRow {
  id: string;
  label: string;
  titles: TitleCardData[];
  nextCursor: string | null;
}
export interface BrowsePage {
  rows: BrowseRow[];
  nextGenre: string | null;
}

export interface FileChoice {
  token: string;
  name: string;
  size?: number;
  format: string;
  sample: boolean;
}
export interface FileSelection {
  provider: ProviderId;
  sourceIndex: number;
  files: FileChoice[];
}

export interface PlaybackData {
  sessionId: string;
  resumeSeconds: number;
  durationSeconds: number;
}
