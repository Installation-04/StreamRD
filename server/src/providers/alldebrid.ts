import {
  DebridProvider,
  DebridUserInfo,
  ProviderCredentials,
  ProviderError,
  TorrentPhase,
  TorrentStatus,
  UnrestrictedLink,
  providerFetch,
} from "./types";

const DEFAULT_BASE = "https://api.alldebrid.com/v4";
const AGENT = "streamrd";

interface AdEnvelope<T> {
  status: "success" | "error";
  data?: T;
  error?: { code: string; message: string };
}

/** AllDebrid magnet statusCode → uniform phase. 4 = ready. */
function mapPhase(statusCode: number): TorrentPhase {
  if (statusCode === 4) return "finished";
  if (statusCode >= 5) return "error";
  if (statusCode === 0) return "queued";
  return "downloading";
}

interface AdMagnet {
  id: number;
  filename: string;
  statusCode: number;
  downloaded: number;
  size: number;
  links: Array<{ link: string }>;
}

function toStatus(m: AdMagnet): TorrentStatus {
  return {
    provider: "alldebrid",
    id: String(m.id),
    name: m.filename,
    phase: mapPhase(m.statusCode),
    progress:
      m.size > 0 ? Math.min(100, Math.round((m.downloaded / m.size) * 100)) : 0,
    links: (m.links ?? []).map((l) => l.link),
  };
}

/**
 * AllDebrid v4 client. Auth is an apikey passed as a query parameter along
 * with an agent name (required by their API terms).
 */
export class AllDebridProvider implements DebridProvider {
  readonly id = "alldebrid" as const;
  readonly displayName = "AllDebrid";

  private async request<T>(
    creds: ProviderCredentials,
    path: string,
    params: Record<string, string> = {},
    init: RequestInit = {}
  ): Promise<T> {
    const base = creds.baseUrl ?? DEFAULT_BASE;
    const qs = new URLSearchParams({ agent: AGENT, apikey: creds.apiKey, ...params });
    const res = await providerFetch(
      this.id,
      `${base}${path}?${qs}`,
      init,
      creds.timeoutMs
    );
    if (!res.ok) throw new ProviderError(this.id, `HTTP ${res.status}`, res.status);
    const body = (await res.json()) as AdEnvelope<T>;
    if (body.status !== "success" || body.data === undefined) {
      throw new ProviderError(
        this.id,
        body.error?.message ?? "Unknown AllDebrid error"
      );
    }
    return body.data;
  }

  async getUserInfo(creds: ProviderCredentials): Promise<DebridUserInfo> {
    const data = await this.request<{
      user: {
        username: string;
        email: string;
        isPremium: boolean;
        premiumUntil: number;
        fidelityPoints: number;
      };
    }>(creds, "/user");
    return {
      provider: this.id,
      username: data.user.username,
      email: data.user.email,
      premium: data.user.isPremium,
      premiumUntil: data.user.premiumUntil
        ? new Date(data.user.premiumUntil * 1000).toISOString()
        : undefined,
      points: data.user.fidelityPoints,
    };
  }

  async unrestrictLink(
    creds: ProviderCredentials,
    url: string
  ): Promise<UnrestrictedLink> {
    const data = await this.request<{
      link: string;
      filename: string;
      filesize: number;
    }>(creds, "/link/unlock", { link: url });
    return {
      provider: this.id,
      url: data.link,
      filename: data.filename,
      filesize: data.filesize,
    };
  }

  async addTorrent(
    creds: ProviderCredentials,
    magnetOrTorrentUrl: string
  ): Promise<TorrentStatus> {
    const data = await this.request<{
      magnets: Array<{ id: number; name: string; error?: { message: string } }>;
    }>(creds, "/magnet/upload", { "magnets[]": magnetOrTorrentUrl }, { method: "POST" });
    const magnet = data.magnets[0];
    if (!magnet || magnet.error) {
      throw new ProviderError(this.id, magnet?.error?.message ?? "Magnet rejected");
    }
    return this.getTorrentStatus(creds, String(magnet.id));
  }

  async getTorrentStatus(
    creds: ProviderCredentials,
    id: string
  ): Promise<TorrentStatus> {
    const data = await this.request<{ magnets: AdMagnet }>(creds, "/magnet/status", {
      id,
    });
    return toStatus(data.magnets);
  }

  async listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]> {
    const data = await this.request<{ magnets: AdMagnet[] }>(creds, "/magnet/status");
    const magnets = Array.isArray(data.magnets) ? data.magnets : [data.magnets];
    return magnets.map(toStatus);
  }
}
