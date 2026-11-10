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
  /** Absolute deadline shared by bounded existing-account scan/play requests. */
  deadline?: number;
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
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: ArrayBuffer | null = null;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new ProviderError(provider, "Provider response exceeded the allowed size", 502);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = bytes.buffer;
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new ProviderError(provider, `Request timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(provider, (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
