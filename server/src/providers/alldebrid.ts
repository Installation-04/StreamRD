import {
  DebridProvider,
  DebridUserInfo,
  ProviderCredentials,
  ProviderError,
  TorrentPhase,
  TorrentStatus,
  TorrentFile,
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
      creds.timeoutMs,
      creds.deadline
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
    const status = toStatus(data.magnets);
    if (status.phase === "finished") {
      type Entry = { n: string; s?: number; l?: string; e?: Entry[] };
      const result = await this.request<{ magnets: Array<{ id: string | number; files?: Entry[]; error?: { message: string } }> }>(
        creds, "/magnet/files", {}, { method: "POST", body: new URLSearchParams({ "id[]": id }) }
      );
      const magnet = result.magnets.find(item => String(item.id) === id);
      if (!magnet || magnet.error) throw new ProviderError(this.id, magnet?.error?.message ?? "Magnet files unavailable");
      const files: TorrentFile[] = [];
      let entries = 0;
      const visit = (items: Entry[], prefix = "", depth = 0) => {
        if (depth > 32) throw new ProviderError(this.id, "Torrent folder tree is too deep");
        for (const item of items) {
          if (++entries > 5000) throw new ProviderError(this.id, "Torrent contains too many files");
          const path = prefix + item.n;
          if (item.e) visit(item.e, path + "/", depth + 1);
          else if (item.l) files.push({ id: item.l, path, size: item.s, link: item.l });
        }
      };
      visit(magnet.files ?? []);
      status.files = files;
      status.links = files.map(file => file.link);
    }
    return status;
  }

  async listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]> {
    const data = await this.request<{ magnets: AdMagnet[] }>(creds, "/magnet/status");
    const magnets = Array.isArray(data.magnets) ? data.magnets : [data.magnets];
    return magnets.map(toStatus);
  }
}
