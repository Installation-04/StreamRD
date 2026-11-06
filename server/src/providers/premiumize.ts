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
  file_id?: string | null;
  folder_id?: string | null;
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
      creds.timeoutMs,
      creds.deadline
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
    const body = await this.request<{ status: string; transfers: PmTransfer[] }>(creds, "/transfer/list");
    const transfer = body.transfers.find(item => item.id === id);
    if (!transfer) throw new ProviderError(this.id, `Transfer ${id} not found`, 404);
    const status = toStatus(transfer);
    if (status.phase !== "finished") return status;
    type Item = { id: string; name: string; type?: string; size?: number; link?: string };
    const files: TorrentFile[] = [];
    const add = (item: Item, prefix = "") => {
      if (item.link) files.push({ id: item.id, path: prefix + item.name, size: item.size, link: item.link, direct: true });
      if (files.length > 5000) throw new ProviderError(this.id, "Transfer contains too many files");
    };
    if (transfer.file_id) {
      const file = await this.request<Item & { status: string }>(creds, "/item/details", { id: transfer.file_id });
      add(file);
    } else if (transfer.folder_id) {
      const queue = [{ id: transfer.folder_id, prefix: "", depth: 0 }];
      const visited = new Set<string>();
      while (queue.length) {
        const folder = queue.shift()!;
        if (visited.has(folder.id)) continue;
        if (visited.size >= 100 || folder.depth > 32) throw new ProviderError(this.id, "Transfer folder tree is too large");
        visited.add(folder.id);
        const content = await this.request<{ status: string; content: Item[] }>(creds, "/folder/list", { id: folder.id });
        for (const item of content.content ?? []) {
          if (item.type === "folder") queue.push({ id: item.id, prefix: folder.prefix + item.name + "/", depth: folder.depth + 1 });
          else add(item, folder.prefix);
        }
        if (queue.length > 5000) throw new ProviderError(this.id, "Transfer contains too many folders");
      }
    } else {
      throw new ProviderError(this.id, "Finished transfer has no files in your Premiumize cloud");
    }
    return { ...status, files, links: files.map(file => file.link) };
  }

  async listTorrents(creds: ProviderCredentials): Promise<TorrentStatus[]> {
    const body = await this.request<{ status: string; transfers: PmTransfer[] }>(
      creds,
      "/transfer/list"
    );
    return (body.transfers ?? []).map((t) => toStatus(t));
  }
}
