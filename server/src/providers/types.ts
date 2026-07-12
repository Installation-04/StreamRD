/** Identifiers for the built-in debrid providers. Extend this list to add more. */
export const PROVIDER_IDS = ["realdebrid", "alldebrid", "premiumize"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface DebridUserInfo {
  provider: ProviderId;
  username: string;
  email?: string;
  premium: boolean;
  /** Premium expiry as ISO string, when the provider reports one. */
  premiumUntil?: string;
  points?: number;
}

export interface UnrestrictedLink {
  provider: ProviderId;
  /** Direct, streamable/downloadable URL. */
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
  /** Direct links available once the torrent is finished. */
  links: string[];
}

export interface ProviderCredentials {
  /** API token / key for the provider, from the user's DebridConfig. */
  apiKey: string;
  /** Optional base URL override from global provider settings. */
  baseUrl?: string;
  /** Request timeout in ms (from server settings). */
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
