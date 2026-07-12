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

const DEFAULT_BASE = "https://www.premiumize.me/api";

function mapPhase(status: string): TorrentPhase {
  switch (status) {
    case "finished":
    case "seeding":
      return "finished";
    case "waiting":
    case "queued":
      return "queued";
    case "running":
      return "downloading";
    default:
      return "error";
  }
}

interface PmTransfer {
  id: string;
  name: string;
  status: string;
  progress: number; // 0..1
}

function toStatus(t: PmTransfer, links: string[] = []): TorrentStatus {
  return {
    provider: "premiumize",
    id: t.id,
    name: t.name,
    phase: mapPhase(t.status),
    progress: Math.round((t.progress ?? 0) * 100),
    links,
  };
}

/**
 * Premiumize.me client. Auth is an apikey query parameter
 * (from https://www.premiumize.me/account).
 */
export class PremiumizeProvider implements DebridProvider {
  readonly id = "premiumize" as const;
  readonly displayName = "Premiumize.me";

  private async request<T extends { status: string; message?: string }>(
    creds: ProviderCredentials,
    path: string,
    params: Record<string, string> = {},
    init: RequestInit = {}
  ): Promise<T> {
    const base = creds.baseUrl ?? DEFAULT_BASE;
    const qs = new URLSearchParams({ apikey: creds.apiKey, ...params });
    const res = await providerFetch(
      this.id,
      `${base}${path}?${qs}`,
      init,
      creds.timeoutMs
    );
    if (!res.ok) throw new ProviderError(this.id, `HTTP ${res.status}`, res.status);
    const body = (await res.json()) as T;
    if (body.status !== "success") {
      throw new ProviderError(this.id, body.message ?? "Unknown Premiumize error");
    }
    return body;
  }

  async getUserInfo(creds: ProviderCredentials): Promise<DebridUserInfo> {
    const body = await this.request<{
      status: string;
      customer_id: string;
      premium_until: number;
      space_used: number;
    }>(creds, "/account/info");
    const premiumUntil = body.premium_until
      ? new Date(body.premium_until * 1000)
      : undefined;
    return {
      provider: this.id,
      username: String(body.customer_id),
      premium: !!premiumUntil && premiumUntil.getTime() > Date.now(),
      premiumUntil: premiumUntil?.toISOString(),
    };
  }

  async unrestrictLink(
    creds: ProviderCredentials,
    url: string
  ): Promise<UnrestrictedLink> {
    const body = await this.request<{
      status: string;
      content: Array<{ link: string; path: string; size: number }>;
    }>(creds, "/transfer/directdl", { src: url }, { method: "POST" });
    const first = body.content?.[0];
    if (!first) throw new ProviderError(this.id, "No downloadable content returned");
    return {
      provider: this.id,
      url: first.link,
      filename: first.path.split("/").pop() ?? first.path,
      filesize: first.size,
    };
  }

  async addTorrent(
    creds: ProviderCredentials,
    magnetOrTorrentUrl: string
  ): Promise<TorrentStatus> {
    const body = await this.request<{
      status: string;
      id: string;
      name: string;
    }>(creds, "/transfer/create", { src: magnetOrTorrentUrl }, { method: "POST" });
    return this.getTorrentStatus(creds, body.id);
  }

  async getTorrentStatus(
    creds: ProviderCredentials,
    id: string
  ): Promise<TorrentStatus> {
    const transfers = await this.listTorrents(creds);
    const found = transfers.find((t) => t.id === id);
    if (!found) throw new ProviderError(this.id, `Transfer ${id} not found`);
    return found;
  }

  async listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]> {
    const body = await this.request<{ status: string; transfers: PmTransfer[] }>(
      creds,
      "/transfer/list"
    );
    return (body.transfers ?? []).map((t) => toStatus(t));
  }
}
