import { DebridConfig } from "@prisma/client";
import { logEvent } from "../logger";
import { increment } from "../metrics";
import { getProviderSettings, getServerSettings, ServerSettings } from "../settings";
import { getProvider } from "./registry";
import {
  DebridUserInfo,
  PROVIDER_IDS,
  ProviderCredentials,
  ProviderError,
  ProviderId,
  TorrentStatus,
  UnrestrictedLink,
} from "./types";

function apiKeyFor(cfg: DebridConfig, id: ProviderId): string | null {
  switch (id) {
    case "realdebrid":
      return cfg.realDebridToken;
    case "alldebrid":
      return cfg.allDebridApiKey;
    case "premiumize":
      return cfg.premiumizeApiKey;
    case "torbox":
      return cfg.torboxApiKey;
  }
}

function parseOrder(json: string): ProviderId[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((p): p is ProviderId => PROVIDER_IDS.includes(p)) : [];
  } catch {
    return [];
  }
}

export interface ResolvedStream extends UnrestrictedLink {}

/**
 * Chooses and drives debrid providers for a user: primary provider first,
 * then the user's personal fallback order (or the global order), skipping
 * providers that are globally disabled or missing credentials.
 */
export class DebridManager {
  async providerOrderFor(cfg: DebridConfig, settings?: ServerSettings): Promise<ProviderId[]> {
    const server = settings ?? (await getServerSettings());
    const providerSettings = await getProviderSettings();
    const personal = parseOrder(cfg.fallbackOrder);
    const base = personal.length > 0 ? personal : server.providerOrder;
    const ordered = [cfg.primaryProvider as ProviderId, ...base.filter((p) => p !== cfg.primaryProvider)];
    return ordered.filter(
      (id) =>
        PROVIDER_IDS.includes(id) &&
        !server.disabledProviders.includes(id) &&
        providerSettings[id]?.enabled !== false &&
        !!apiKeyFor(cfg, id)
    );
  }

  async credentialsFor(cfg: DebridConfig, id: ProviderId): Promise<ProviderCredentials> {
    const [server, providerSettings] = await Promise.all([getServerSettings(), getProviderSettings()]);
    const apiKey = apiKeyFor(cfg, id);
    if (!apiKey) throw new ProviderError(id, "No API key configured for this provider");
    return { apiKey, baseUrl: providerSettings[id]?.baseUrl, timeoutMs: server.providerTimeoutMs };
  }

  async getUserInfo(cfg: DebridConfig, providerId?: ProviderId): Promise<DebridUserInfo> {
    const id = providerId ?? (cfg.primaryProvider as ProviderId);
    const creds = await this.credentialsFor(cfg, id);
    return getProvider(id).getUserInfo(creds);
  }

  /**
   * Adds a magnet/link to the given provider and returns the initial
   * torrent status (queued/downloading/finished with links).
   */
  async submit(cfg: DebridConfig, providerId: ProviderId, sourceUrl: string): Promise<TorrentStatus> {
    const creds = await this.credentialsFor(cfg, providerId);
    const provider = getProvider(providerId);
    if (sourceUrl.startsWith("magnet:")) {
      return provider.addTorrent(creds, sourceUrl);
    }
    // A direct hoster link: resolve it immediately and report it as "finished"
    // with the resolved link so the caller's polling loop treats it uniformly.
    const link = await provider.unrestrictLink(creds, sourceUrl);
    return { provider: providerId, id: link.url, name: link.filename, phase: "finished", progress: 100, links: [link.url] };
  }

  /** Refreshes a job's status from its provider and resolves a stream link once ready. */
  async refresh(
    cfg: DebridConfig,
    providerId: ProviderId,
    providerRef: string
  ): Promise<{ status: TorrentStatus; stream?: ResolvedStream }> {
    const creds = await this.credentialsFor(cfg, providerId);
    const provider = getProvider(providerId);
    const status = await provider.getTorrentStatus(creds, providerRef);
    if (status.phase !== "finished" || status.links.length === 0) return { status };
    try {
      const stream = await provider.unrestrictLink(creds, status.links[0]);
      increment(`resolved.${providerId}`);
      return { status, stream };
    } catch (err) {
      increment(`provider_errors.${providerId}`);
      await logEvent("warn", "provider_error", (err as Error).message, { provider: providerId });
      return { status };
    }
  }
}

export const debridManager = new DebridManager();
