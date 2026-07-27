/** Identifiers for the built-in debrid providers. Extend this list to add more. */
export const PROVIDER_IDS = ["realdebrid", "alldebrid", "premiumize", "torbox"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface DebridUserInfo {
  provider: ProviderId;
  username: string;
  email?: string;
  premium: boolean;
  premiumUntil?: string;
  points?: number;
}

export interface UnrestrictedLink {
  provider: ProviderId;
  url: string;
  filename: string;
  filesize?: number;
  mimeType?: string;
}

export type TorrentPhase = "queued" | "downloading" | "finished" | "error";

export interface TorrentStatus {
  provider: ProviderId;
  id: string;
  name: string;
  phase: TorrentPhase;
  /** 0-100 */
  progress: number;
  /** Links ready to be resolved via unrestrictLink once the torrent is finished. */
  links: string[];
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Uniform contract every debrid service must implement. The rest of the
 * system only ever talks to this interface, so adding a provider means
 * implementing these five methods and registering it in registry.ts.
 */
export interface DebridProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  getUserInfo(creds: ProviderCredentials): Promise<DebridUserInfo>;
  unrestrictLink(creds: ProviderCredentials, url: string): Promise<UnrestrictedLink>;
  addTorrent(creds: ProviderCredentials, magnetOrTorrentUrl: string): Promise<TorrentStatus>;
  getTorrentStatus(creds: ProviderCredentials, id: string): Promise<TorrentStatus>;
  listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]>;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderId,
    message: string,
    public readonly statusCode?: number
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

/** fetch with a timeout, shared by all providers. */
export async function providerFetch(
  provider: ProviderId,
  url: string,
  init: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new ProviderError(provider, `Request timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(provider, (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
