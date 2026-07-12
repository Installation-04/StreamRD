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
  UnrestrictedLink,
} from "./types";

export interface TitleSource {
  kind: "link" | "magnet";
  url: string;
  quality?: string;
  label?: string;
}

export interface ResolvedStream extends UnrestrictedLink {
  quality?: string;
  label?: string;
}

function apiKeyFor(cfg: DebridConfig, id: ProviderId): string | null {
  switch (id) {
    case "realdebrid":
      return cfg.realDebridToken;
    case "alldebrid":
      return cfg.allDebridApiKey;
    case "premiumize":
      return cfg.premiumizeApiKey;
  }
}

function parseOrder(json: string): ProviderId[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr)
      ? arr.filter((p): p is ProviderId => PROVIDER_IDS.includes(p))
      : [];
  } catch {
    return [];
  }
}

/**
 * Chooses and drives debrid providers for a user: primary provider first,
 * then the user's personal fallback order (or the global order), skipping
 * providers that are globally disabled or missing credentials.
 */
export class DebridManager {
  /** Ordered list of providers this user can actually use right now. */
  async providerOrderFor(
    cfg: DebridConfig,
    settings?: ServerSettings
  ): Promise<ProviderId[]> {
    const server = settings ?? (await getServerSettings());
    const providerSettings = await getProviderSettings();
    const personal = parseOrder(cfg.fallbackOrder);
    const base = personal.length > 0 ? personal : server.providerOrder;
    const ordered = [
      cfg.primaryProvider as ProviderId,
      ...base.filter((p) => p !== cfg.primaryProvider),
    ];
    return ordered.filter(
      (id) =>
        PROVIDER_IDS.includes(id) &&
        !server.disabledProviders.includes(id) &&
        providerSettings[id]?.enabled !== false &&
        !!apiKeyFor(cfg, id)
    );
  }

  async credentialsFor(cfg: DebridConfig, id: ProviderId): Promise<ProviderCredentials> {
    const [server, providerSettings] = await Promise.all([
      getServerSettings(),
      getProviderSettings(),
    ]);
    const apiKey = apiKeyFor(cfg, id);
    if (!apiKey) throw new ProviderError(id, "No API key configured for this provider");
    return {
      apiKey,
      baseUrl: providerSettings[id]?.baseUrl,
      timeoutMs: server.providerTimeoutMs,
    };
  }

  /** Account info from the user's primary (or an explicitly chosen) provider. */
  async getUserInfo(cfg: DebridConfig, providerId?: ProviderId): Promise<DebridUserInfo> {
    const id = providerId ?? (cfg.primaryProvider as ProviderId);
    const creds = await this.credentialsFor(cfg, id);
    return getProvider(id).getUserInfo(creds);
  }

  /**
   * Resolves a playable stream for a title source, walking the user's
   * provider order until one succeeds. Returns the stream plus which
   * provider produced it; throws the last error when all fail.
   */
  async resolveStream(cfg: DebridConfig, sources: TitleSource[]): Promise<ResolvedStream> {
    const server = await getServerSettings();
    const order = (await this.providerOrderFor(cfg, server)).slice(
      0,
      Math.max(1, server.maxPlaybackAttempts)
    );
    if (order.length === 0) {
      throw new ProviderError(
        cfg.primaryProvider as ProviderId,
        "No usable debrid provider: add an API key in your debrid settings"
      );
    }
    let lastError: Error = new ProviderError(order[0], "No playable source on title");
    for (const source of sources) {
      for (const id of order) {
        const provider = getProvider(id);
        const creds = await this.credentialsFor(cfg, id);
        try {
          const link = await this.resolveSource(provider.id, creds, source);
          increment(`plays.${id}`);
          return { ...link, quality: source.quality, label: source.label };
        } catch (err) {
          lastError = err as Error;
          increment(`provider_errors.${id}`);
          await logEvent("warn", "provider_error", (err as Error).message, {
            provider: id,
          });
        }
      }
    }
    throw lastError;
  }

  private async resolveSource(
    id: ProviderId,
    creds: ProviderCredentials,
    source: TitleSource
  ): Promise<UnrestrictedLink> {
    const provider = getProvider(id);
    if (source.kind === "link") {
      return provider.unrestrictLink(creds, source.url);
    }
    // Magnet: hand it to the provider's cloud; if it is already cached the
    // torrent finishes immediately and we can unrestrict the first file.
    const torrent = await provider.addTorrent(creds, source.url);
    if (torrent.phase === "finished" && torrent.links.length > 0) {
      return provider.unrestrictLink(creds, torrent.links[0]);
    }
    throw new ProviderError(
      id,
      `Torrent not ready yet (${torrent.phase}, ${torrent.progress}%) — try again shortly`
    );
  }
}

export const debridManager = new DebridManager();
