import { z } from "zod";
import { db } from "../db";
import { MetadataError, MetadataProvider, MetadataSettings, PublicMetadataSettings } from "./types";

export const METADATA_SETTINGS_KEY = "metadata.settings";
export const DEFAULT_METADATA_SETTINGS: Readonly<MetadataSettings> = Object.freeze({
  provider: "tmdb", language: "en-US", automatic: false, refreshDays: 30,
  tmdbApiKey: "", omdbApiKey: "",
});
const apiKey = z.string().trim().max(1024).refine(value => /^[\x21-\x7e]*$/.test(value), "Use a valid API key without spaces or control characters");
const tmdbKey = z.string().trim().transform(value => value.replace(/^Bearer\s+/i, "")).pipe(apiKey);
export const metadataSettingsPatchSchema = z.object({
  provider: z.enum(["tmdb", "omdb", "free"]).optional(),
  language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, "Use a language-region code such as en-US").optional(),
  automatic: z.boolean().optional(),
  refreshDays: z.number().int().min(1).max(90).optional(),
  tmdbApiKey: tmdbKey.optional(), omdbApiKey: apiKey.optional(),
  clearTmdb: z.boolean().optional(), clearOmdb: z.boolean().optional(),
}).strict();
export type MetadataSettingsPatch = z.input<typeof metadataSettingsPatchSchema>;

/** The credential a provider is called with; the built-in source needs none, so it is always "configured". */
export function providerCredential(settings: MetadataSettings, provider: MetadataProvider): string {
  return provider === "tmdb" ? settings.tmdbApiKey : provider === "omdb" ? settings.omdbApiKey : "built-in";
}
export function providerConfigured(settings: MetadataSettings, provider: MetadataProvider = settings.provider): boolean {
  return Boolean(providerCredential(settings, provider));
}
/** The chosen provider while it has a key; otherwise the built-in source, so matching works with no account at all. */
export function activeProvider(settings: MetadataSettings): MetadataProvider {
  return providerConfigured(settings) ? settings.provider : "free";
}

/** Whitelist stored fields, including on reads of older/malformed configuration. */
function decodeMetadataSettings(row: { value: string } | null): MetadataSettings {
  let stored: Record<string, unknown> = {};
  try {
    const value: unknown = row ? JSON.parse(row.value) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) stored = value as Record<string, unknown>;
  } catch { /* Invalid persisted settings safely fall back to disabled defaults. */ }
  const read = <K extends keyof MetadataSettings>(key: K): MetadataSettings[K] => {
    const parsed = metadataSettingsPatchSchema.shape[key].safeParse(stored[key]);
    return (parsed.success && parsed.data !== undefined ? parsed.data : DEFAULT_METADATA_SETTINGS[key]) as MetadataSettings[K];
  };
  const settings: MetadataSettings = {
    provider: read("provider"), language: read("language"), automatic: read("automatic"),
    refreshDays: read("refreshDays"), tmdbApiKey: read("tmdbApiKey"), omdbApiKey: read("omdbApiKey"),
  };
  return settings;
}
export async function getMetadataSettings(): Promise<MetadataSettings> {
  return decodeMetadataSettings(await db.setting.findUnique({ where: { key: METADATA_SETTINGS_KEY } }));
}
export function publicMetadataSettings(settings: MetadataSettings): PublicMetadataSettings {
  return {
    provider: settings.provider, language: settings.language, automatic: settings.automatic,
    refreshDays: settings.refreshDays, activeProvider: activeProvider(settings), tmdbConfigured: Boolean(settings.tmdbApiKey),
    omdbConfigured: Boolean(settings.omdbApiKey),
  };
}
export async function saveMetadataSettings(patch: MetadataSettingsPatch): Promise<void> {
  const parsed = metadataSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw new MetadataError("metadata-settings-invalid", 400, "Metadata settings are invalid; check provider, language, refresh interval and API key fields.");
  // Serialize partial updates at the database boundary: a parallel save must
  // merge against the latest committed values, particularly cleared API keys.
  await db.$transaction(async transaction => {
    const current = decodeMetadataSettings(await transaction.setting.findUnique({ where: { key: METADATA_SETTINGS_KEY } }));
    const input = parsed.data;
    const settings: MetadataSettings = {
      provider: input.provider ?? current.provider,
      language: input.language ?? current.language,
      automatic: input.automatic ?? current.automatic,
      refreshDays: input.refreshDays ?? current.refreshDays,
      tmdbApiKey: input.clearTmdb ? "" : input.tmdbApiKey || current.tmdbApiKey,
      omdbApiKey: input.clearOmdb ? "" : input.omdbApiKey || current.omdbApiKey,
    };
    const value = JSON.stringify(settings);
    await transaction.setting.upsert({ where: { key: METADATA_SETTINGS_KEY }, create: { key: METADATA_SETTINGS_KEY, value }, update: { value } });
  });
}
