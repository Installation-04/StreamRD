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

const DEFAULT_BASE = "https://api.torbox.app/v1";

interface TbEnvelope<T> {
  success: boolean;
  error?: string | null;
  detail?: string;
  data?: T;
}

function mapTorrentPhase(state: string): TorrentPhase {
  switch (state) {
    case "completed":
    case "cached":
      return "finished";
    case "downloading":
    case "uploading":
    case "metaDL":
    case "checkingResumeData":
      return "downloading";
    case "paused":
    case "stalled (no seeds)":
      return "queued";
    default:
      // Torbox has no explicit "failed" download_state; an unrecognized
      // value is more likely an in-progress state we haven't enumerated
      // than an actual failure.
      return "downloading";
  }
}

interface TbFile {
  id: number;
  short_name: string;
  name: string;
  size: number;
}

interface TbTorrent {
  id: number;
  name: string;
  download_state: string;
  progress: number; // 0..1
  download_finished: boolean;
  files: TbFile[];
}

/**
 * Torbox client (api.torbox.app/v1). Auth is a bearer token from the
 * TorBox dashboard. Torbox has two parallel pipelines — torrents and web
 * (hoster) downloads — so unrestrictLink dispatches on a pseudo-URL scheme
 * (`torbox://torrent/<id>/<fileId>`) that addTorrent/getTorrentStatus
 * produce, while a plain http(s) URL goes through the web-download pipeline.
 *
 * The /api/webdl/* endpoints mirror the /api/torrents/* shape documented by
 * TorBox's SDKs; this hasn't been verified against a live account and may
 * need adjustment if TorBox's actual webdl response fields differ.
 */
export class TorboxProvider implements DebridProvider {
  readonly id = "torbox" as const;
  readonly displayName = "Torbox";

  private async request<T>(
    creds: ProviderCredentials,
    path: string,
    init: RequestInit = {},
    params: Record<string, string> = {}
  ): Promise<T> {
    const base = creds.baseUrl ?? DEFAULT_BASE;
    const qs = new URLSearchParams(params);
    const url = qs.toString() ? `${base}${path}?${qs}` : `${base}${path}`;
    const res = await providerFetch(
      this.id,
      url,
      { ...init, headers: { Authorization: `Bearer ${creds.apiKey}`, ...(init.headers ?? {}) } },
      creds.timeoutMs
    );
    const body = (await res.json().catch(() => ({}))) as TbEnvelope<T>;
    if (!res.ok || !body.success) {
      throw new ProviderError(this.id, body.detail ?? body.error ?? `HTTP ${res.status}`, res.status);
    }
    return body.data as T;
  }

  private toStatus(t: TbTorrent): TorrentStatus {
    const finished = t.download_finished || mapTorrentPhase(t.download_state) === "finished";
    return {
      provider: this.id,
      id: String(t.id),
      name: t.name,
      phase: finished ? "finished" : mapTorrentPhase(t.download_state),
      progress: Math.round((t.progress ?? 0) * 100),
      links: finished ? t.files.map((f) => `torbox://torrent/${t.id}/${f.id}`) : [],
    };
  }

  async getUserInfo(creds: ProviderCredentials): Promise<DebridUserInfo> {
    const data = await this.request<{ id: number; email: string; plan: number }>(creds, "/api/user/me");
    return {
      provider: this.id,
      username: data.email ?? String(data.id),
      email: data.email,
      premium: data.plan > 0,
    };
  }

  async unrestrictLink(creds: ProviderCredentials, url: string): Promise<UnrestrictedLink> {
    const pseudo = url.match(/^torbox:\/\/(torrent|webdl)\/(\d+)\/(\d+)$/);
    if (pseudo) {
      const [, kind, refId, fileId] = pseudo;
      const path = kind === "torrent" ? "/api/torrents/requestdl" : "/api/webdl/requestdl";
      const idParam = kind === "torrent" ? "torrent_id" : "web_id";
      const link = await this.request<string>(
        creds,
        path,
        {},
        { token: creds.apiKey, [idParam]: refId, file_id: fileId, redirect: "false" }
      );
      return { provider: this.id, url: link, filename: `file-${fileId}` };
    }
    // Plain hoster URL: run it through the web-download pipeline.
    const created = await this.request<{ webdownload_id?: number; id?: number }>(
      creds,
      "/api/webdl/createwebdownload",
      { method: "POST", body: new URLSearchParams({ link: url }) }
    );
    const webId = created.webdownload_id ?? created.id;
    if (!webId) throw new ProviderError(this.id, "Web download was not created");
    const status = await this.getWebDownloadStatus(creds, String(webId));
    if (status.phase !== "finished" || status.links.length === 0) {
      throw new ProviderError(this.id, `Web download not ready yet (${status.phase}, ${status.progress}%)`);
    }
    return this.unrestrictLink(creds, status.links[0]);
  }

  private async getWebDownloadStatus(creds: ProviderCredentials, id: string): Promise<TorrentStatus> {
    const t = await this.request<TbTorrent>(creds, "/api/webdl/mylist", {}, { id });
    const finished = t.download_finished || mapTorrentPhase(t.download_state) === "finished";
    return {
      provider: this.id,
      id: String(t.id),
      name: t.name,
      phase: finished ? "finished" : mapTorrentPhase(t.download_state),
      progress: Math.round((t.progress ?? 0) * 100),
      links: finished ? t.files.map((f) => `torbox://webdl/${t.id}/${f.id}`) : [],
    };
  }

  async addTorrent(creds: ProviderCredentials, magnetOrTorrentUrl: string): Promise<TorrentStatus> {
    if (!magnetOrTorrentUrl.startsWith("magnet:")) {
      throw new ProviderError(this.id, "Only magnet links are supported via the API");
    }
    const created = await this.request<{ torrent_id: number }>(creds, "/api/torrents/createtorrent", {
      method: "POST",
      body: new URLSearchParams({ magnet: magnetOrTorrentUrl }),
    });
    return this.getTorrentStatus(creds, String(created.torrent_id));
  }

  async getTorrentStatus(creds: ProviderCredentials, id: string): Promise<TorrentStatus> {
    const t = await this.request<TbTorrent>(creds, "/api/torrents/mylist", {}, { id });
    return this.toStatus(t);
  }

  async listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]> {
    const list = await this.request<TbTorrent[]>(creds, "/api/torrents/mylist");
    return (list ?? []).map((t) => this.toStatus(t));
  }
}
