import type { MetadataDetails } from "./metadata";

export type AccountProvider = "realdebrid" | "alldebrid" | "premiumize" | "torbox";
export const ACCOUNT_PROVIDER_NAMES: Record<AccountProvider, string> = { realdebrid: "Real-Debrid", alldebrid: "AllDebrid", premiumize: "Premiumize", torbox: "TorBox" };
export interface AccountMedia {
  id: string; name: string; type: "movie" | "series"; year: number | null;
  provider: AccountProvider; phase: "queued" | "downloading" | "finished" | "error";
  progress: number; createdAt: string; metadata: MetadataDetails | null; metadataStatus: string | null;
}
export type ScanState = "not-started" | "queued" | "scanning" | "complete" | "error" | "cancelled";
export interface AccountProviderScan {
  provider: AccountProvider; configured: boolean; enabled: boolean; status: ScanState;
  scanned: number; imported: number; skipped: number; error: string | null; updatedAt: string | null;
}
export interface AccountScans { automatic: boolean; providers: AccountProviderScan[]; totalImported: number }
export interface AccountLibraryPage { items: AccountMedia[]; nextCursor: string | null; total: number }
export interface AccountPlayResult {
  stream?: { provider: AccountProvider; url: string; filename: string; filesize?: number; mimeType?: string };
  selectionRequired?: boolean; files?: Array<{ token: string; name: string; size?: number }>;
  pending?: boolean; progress?: number;
  /** Shared-library plays only: resume support for the signed-in viewer. */
  progressSessionId?: string; resumeSeconds?: number; durationSeconds?: number;
}
export function safeMediaUrl(value: string | null | undefined): string | null {
  try { const url = new URL(value ?? ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function accountMediaName(item: AccountMedia) { return item.metadata?.name || item.name; }
