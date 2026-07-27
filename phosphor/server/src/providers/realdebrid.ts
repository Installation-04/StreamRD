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

const DEFAULT_BASE = "https://api.real-debrid.com/rest/1.0";

function mapPhase(status: string): TorrentPhase {
  switch (status) {
    case "downloaded":
      return "finished";
    case "queued":
    case "magnet_conversion":
    case "waiting_files_selection":
      return "queued";
    case "downloading":
    case "compressing":
    case "uploading":
      return "downloading";
    default:
      return "error";
  }
}

/** Real-Debrid REST v1.0 client. Auth is a bearer token from real-debrid.com/apitoken. */
export class RealDebridProvider implements DebridProvider {
  readonly id = "realdebrid" as const;
  readonly displayName = "Real-Debrid";

  private async request<T>(creds: ProviderCredentials, path: string, init: RequestInit = {}): Promise<T> {
    const base = creds.baseUrl ?? DEFAULT_BASE;
    const res = await providerFetch(
      this.id,
      `${base}${path}`,
      { ...init, headers: { Authorization: `Bearer ${creds.apiKey}`, ...(init.headers ?? {}) } },
      creds.timeoutMs
    );
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new ProviderError(this.id, detail, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getUserInfo(creds: ProviderCredentials): Promise<DebridUserInfo> {
    const u = await this.request<{
      username: string;
      email: string;
      premium: number;
      expiration: string;
      points: number;
      type: string;
    }>(creds, "/user");
    return {
      provider: this.id,
      username: u.username,
      email: u.email,
      premium: u.type === "premium" || u.premium > 0,
      premiumUntil: u.expiration,
      points: u.points,
    };
  }

  async unrestrictLink(creds: ProviderCredentials, url: string): Promise<UnrestrictedLink> {
    const body = new URLSearchParams({ link: url });
    const r = await this.request<{ download: string; filename: string; filesize: number; mimeType: string }>(
      creds,
      "/unrestrict/link",
      { method: "POST", body }
    );
    return { provider: this.id, url: r.download, filename: r.filename, filesize: r.filesize, mimeType: r.mimeType };
  }

  async addTorrent(creds: ProviderCredentials, magnetOrTorrentUrl: string): Promise<TorrentStatus> {
    if (!magnetOrTorrentUrl.startsWith("magnet:")) {
      throw new ProviderError(this.id, "Only magnet links are supported via the API");
    }
    const body = new URLSearchParams({ magnet: magnetOrTorrentUrl });
    const added = await this.request<{ id: string }>(creds, "/torrents/addMagnet", { method: "POST", body });
    await this.request<void>(creds, `/torrents/selectFiles/${added.id}`, {
      method: "POST",
      body: new URLSearchParams({ files: "all" }),
    });
    return this.getTorrentStatus(creds, added.id);
  }

  async getTorrentStatus(creds: ProviderCredentials, id: string): Promise<TorrentStatus> {
    const t = await this.request<{ id: string; filename: string; status: string; progress: number; links: string[] }>(
      creds,
      `/torrents/info/${id}`
    );
    return { provider: this.id, id: t.id, name: t.filename, phase: mapPhase(t.status), progress: t.progress, links: t.links ?? [] };
  }

  async listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]> {
    const list = await this.request<
      Array<{ id: string; filename: string; status: string; progress: number; links: string[] }>
    >(creds, "/torrents");
    return list.map((t) => ({
      provider: this.id,
      id: t.id,
      name: t.filename,
      phase: mapPhase(t.status),
      progress: t.progress,
      links: t.links ?? [],
    }));
  }
}
