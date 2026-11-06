import { mediaKeyFor } from "../progress";
import { FileSelectionRequired, InvalidFileSelection } from "./files";
import { PendingSourceError, sourceJobs } from "./sourceJobs";
import { DebridConfig } from "@prisma/client";
import { logEvent } from "../logger";
import { increment } from "../metrics";
import { getProviderSettings, getServerSettings, ProviderSettings, ServerSettings } from "../settings";
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
    settings?: ServerSettings,
    providers?: ProviderSettings
  ): Promise<ProviderId[]> {
    const server = settings ?? (await getServerSettings());
    const providerSettings = providers ?? (await getProviderSettings());
    const personal = parseOrder(cfg.fallbackOrder);
    const base = personal.length > 0 ? personal : server.providerOrder;
    const ordered = [
      cfg.primaryProvider as ProviderId,
      ...base.filter((p) => p !== cfg.primaryProvider),
    ];
    return [...new Set(ordered)].filter(
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
  async resolveStream(cfg: DebridConfig, sources: TitleSource[], selection?: { provider: ProviderId; fileToken: string }): Promise<ResolvedStream> {
    const [server, providers] = await Promise.all([getServerSettings(), getProviderSettings()]);
    const order = (await this.providerOrderFor(cfg, server, providers)).filter(id => !selection || id === selection.provider);
    const budget = Math.max(1, server.maxPlaybackAttempts);
    const deadline = Date.now() + server.providerTimeoutMs * budget;
    let attempts = 0;
    let pending: PendingSourceError | undefined;
    const unavailable = new Set<ProviderId>();
    if (order.length === 0) {
      throw new ProviderError(
        cfg.primaryProvider as ProviderId,
        "No usable debrid provider: add an API key in your debrid settings"
      );
    }
    let lastError: Error = new ProviderError(order[0], "No playable source on title");
    sourcesLoop: for (const [sourceIndex, source] of sources.entries()) {
      for (const id of order) {
        if (unavailable.has(id)) continue;
        if (attempts >= budget || Date.now() >= deadline) break sourcesLoop;
        attempts++;
        const provider = getProvider(id);
        const creds: ProviderCredentials = {
          apiKey: apiKeyFor(cfg, id)!,
          baseUrl: providers[id]?.baseUrl,
          timeoutMs: server.providerTimeoutMs,
          deadline,
        };
        try {
          const link = await this.resolveSource(cfg.userId, provider.id, creds, source, selection?.fileToken);
          if (!["http:", "https:"].includes(new URL(link.url).protocol)) throw new ProviderError(id, "Provider returned an invalid stream URL");
          increment(`plays.${id}`);
          return { ...link, quality: source.quality, label: source.label };
        } catch (err) {
          if (err instanceof FileSelectionRequired) { err.sourceIndex = sourceIndex; throw err; }
          if (err instanceof InvalidFileSelection) throw err;
          lastError = err as Error;
          if (err instanceof PendingSourceError) { pending ??= err; continue; }
          if (err instanceof ProviderError && [401, 403, 429].includes(err.statusCode ?? 0)) {
            unavailable.add(id);
          }
          increment(`provider_errors.${id}`);
          await logEvent("warn", "provider_error", (err as Error).message, {
            provider: id,
          });
        }
      }
    }
    throw pending ?? lastError;
  }

  private async resolveSource(
    userId: string,
    id: ProviderId,
    creds: ProviderCredentials,
    source: TitleSource,
    fileToken?: string
  ): Promise<UnrestrictedLink> {
    const provider = getProvider(id);
    if (source.kind === "link") {
      if (fileToken) throw new InvalidFileSelection(id);
      const link = await provider.unrestrictLink(creds, source.url);
      return { ...link, mediaKey: mediaKeyFor(source.url, link.filename, link.filesize) };
    }
    return sourceJobs.resolve(userId, id, creds, source.url, fileToken);
  }
}

export const debridManager = new DebridManager();
