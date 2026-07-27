export type Role = "user" | "admin";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export type ProviderId = "realdebrid" | "alldebrid" | "premiumize" | "torbox";
export const PROVIDER_IDS: ProviderId[] = ["realdebrid", "alldebrid", "premiumize", "torbox"];
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  realdebrid: "Real-Debrid",
  alldebrid: "AllDebrid",
  premiumize: "Premiumize.me",
  torbox: "Torbox",
};

export interface SearchResult {
  indexerId: string;
  indexerName: string;
  title: string;
  link: string;
  hasMagnet: boolean;
  sizeBytes: number;
  seeders: number;
  peers: number;
  publishedAt: string | null;
}

export type JobStatus = "queued" | "downloading" | "finished" | "error";

export interface DownloadJob {
  id: string;
  title: string;
  sourceUrl: string;
  sizeBytes: number;
  seeders: number;
  indexerName: string | null;
  provider: ProviderId;
  status: JobStatus;
  progress: number;
  streamUrl: string | null;
  filename: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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
  maxResolveAttempts: number;
  maxResultsPerIndexer: number;
}

export interface IndexerConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  enabled: boolean;
  createdAt: string;
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
