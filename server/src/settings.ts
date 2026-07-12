import { db } from "./db";
import { PROVIDER_IDS, ProviderId } from "./providers/types";

/** Global server behaviour toggles, editable from the admin panel. */
export interface ServerSettings {
  /** Provider order used when a user has no personal fallback order. */
  providerOrder: ProviderId[];
  /** Providers an admin has disabled globally. */
  disabledProviders: ProviderId[];
  /** Per-request timeout when talking to debrid APIs (ms). */
  providerTimeoutMs: number;
  /** How many providers to try before giving up on playback. */
  maxPlaybackAttempts: number;
  /** Allow browsing the catalog without an account. */
  allowUnauthenticatedBrowse: boolean;
  /** Require a logged-in session to resolve stream URLs. */
  requireLoginForPlayback: boolean;
}

export interface ProviderSettings {
  /** Per-provider global config: feature flags and base URL overrides. */
  [provider: string]: {
    enabled: boolean;
    baseUrl?: string;
  };
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  providerOrder: ["realdebrid", "alldebrid", "premiumize"],
  disabledProviders: [],
  providerTimeoutMs: 15000,
  maxPlaybackAttempts: 3,
  allowUnauthenticatedBrowse: false,
  requireLoginForPlayback: true,
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, { enabled: true }])
);

const SERVER_KEY = "server";
const PROVIDERS_KEY = "providers";

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as T) };
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await db.setting.upsert({
    where: { key },
    create: { key, value: json },
    update: { value: json },
  });
}

export const getServerSettings = () =>
  readJson<ServerSettings>(SERVER_KEY, DEFAULT_SERVER_SETTINGS);

export const saveServerSettings = (s: ServerSettings) => writeJson(SERVER_KEY, s);

export const getProviderSettings = () =>
  readJson<ProviderSettings>(PROVIDERS_KEY, DEFAULT_PROVIDER_SETTINGS);

export const saveProviderSettings = (s: ProviderSettings) =>
  writeJson(PROVIDERS_KEY, s);
