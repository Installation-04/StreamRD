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

/** Maps Real-Debrid torrent status strings onto our uniform phases. */
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

/**
 * Real-Debrid REST v1.0 client. Auth is a bearer token the user creates at
 * https://real-debrid.com/apitoken.
 */
export class RealDebridProvider implements DebridProvider {
  readonly id = "realdebrid" as const;
  readonly displayName = "Real-Debrid";

  private async request<T>(
    creds: ProviderCredentials,
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const base = creds.baseUrl ?? DEFAULT_BASE;
    const res = await providerFetch(
      this.id,
      `${base}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          ...(init.headers ?? {}),
        },
      },
      creds.timeoutMs,
      creds.deadline
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
    // 204 No Content responses (e.g. selectFiles) have no body.
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

  async unrestrictLink(
    creds: ProviderCredentials,
    url: string
  ): Promise<UnrestrictedLink> {
    const body = new URLSearchParams({ link: url });
    const r = await this.request<{
      download: string;
      filename: string;
      filesize: number;
      mimeType: string;
    }>(creds, "/unrestrict/link", { method: "POST", body });
    return {
      provider: this.id,
      url: r.download,
      filename: r.filename,
      filesize: r.filesize,
      mimeType: r.mimeType,
    };
  }

  async addTorrent(
    creds: ProviderCredentials,
    magnetOrTorrentUrl: string
  ): Promise<TorrentStatus> {
    if (!magnetOrTorrentUrl.startsWith("magnet:")) {
      throw new ProviderError(
        this.id,
        "Only magnet links are supported via the API; upload .torrent files in the Real-Debrid UI"
      );
    }
    const body = new URLSearchParams({ magnet: magnetOrTorrentUrl });
    const added = await this.request<{ id: string }>(creds, "/torrents/addMagnet", {
      method: "POST",
      body,
    });
    // Select all files so the torrent actually starts downloading. If that is refused, the torrent just added is removed again, so a refused
    // request leaves nothing behind in the account and can be tried again without a duplicate.
    try {
      await this.request<void>(creds, `/torrents/selectFiles/${added.id}`, {
        method: "POST",
        body: new URLSearchParams({ files: "all" }),
      });
    } catch (error) {
      await this.request<void>(creds, `/torrents/delete/${encodeURIComponent(added.id)}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    }
    return this.getTorrentStatus(creds, added.id);
  }

  async getTorrentStatus(
    creds: ProviderCredentials,
    id: string
  ): Promise<TorrentStatus> {
    const t = await this.request<{
      id: string;
      filename: string;
      status: string;
      progress: number;
      links: string[];
      files?: Array<{ id: number; path: string; bytes: number; selected: number }>;
    }>(creds, `/torrents/info/${id}`);
    const selected = t.files?.filter(file => file.selected === 1);
    // RD links correspond, in order, to the selected files only.
    const files = selected && selected.length === (t.links ?? []).length
      ? selected.map((file, index) => ({ id: String(file.id), path: file.path, size: file.bytes, link: t.links[index] }))
      : t.files ? [] : undefined;
    return {
      provider: this.id,
      id: t.id,
      name: t.filename,
      phase: mapPhase(t.status),
      progress: t.progress,
      links: t.links ?? [],
      files,
    };
  }

  async listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]> {
    const list = await this.request<
      Array<{
        id: string;
        filename: string;
        status: string;
        progress: number;
        links: string[];
      }>
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
