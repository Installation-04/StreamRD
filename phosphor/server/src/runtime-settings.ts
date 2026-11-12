import { z } from "zod";
import { db } from "./db";

/**
 * Settings an administrator changes from the web page instead of a file on the server.
 * Each one used to exist only as an environment variable. The variable is still the starting value, so an install that set one keeps its
 * behaviour; a choice saved from Admin → Server takes its place and survives restarts and updates. Nothing here needs a restart.
 * Values are read synchronously on hot paths (every play asks whether conversion is on), so saved choices are kept in memory:
 * loaded once at start and replaced on every save.
 */
export const RUNTIME_SETTINGS_KEY = "server.runtime";

const off = (name: string, fallback: boolean) => { const value = (process.env[name] ?? "").trim().toLowerCase(); return value ? !["0", "false", "off", "no"].includes(value) : fallback; };
const DEFINITIONS = {
  /** Convert files a browser cannot play while they are watched. */
  transcode: { env: "TRANSCODE", read: () => off("TRANSCODE", true), schema: z.boolean() },
  /** Also re-encode the picture when a file needs it (the heaviest conversion). */
  transcodeVideo: { env: "TRANSCODE_VIDEO", read: () => off("TRANSCODE_VIDEO", true), schema: z.boolean() },
  /** How many videos may be converted at once. */
  transcodeMax: { env: "TRANSCODE_MAX", read: () => Math.max(1, Math.min(8, Number.parseInt(process.env.TRANSCODE_MAX ?? "2", 10) || 2)), schema: z.number().int().min(1).max(8) },
  /** Let the server read media links that point at its own network. */
  transcodeAllowPrivateHosts: { env: "TRANSCODE_ALLOW_PRIVATE_HOSTS", read: () => off("TRANSCODE_ALLOW_PRIVATE_HOSTS", false), schema: z.boolean() },
  /** Check in the background that imported links still work. */
  linkHealth: { env: "LINK_HEALTH", read: () => off("LINK_HEALTH", true), schema: z.boolean() },
  /** Ask the project's release page whether a newer version exists. */
  updateCheck: { env: "UPDATE_CHECK", read: () => off("UPDATE_CHECK", true), schema: z.boolean() },
} as const;

export type RuntimeSettingName = keyof typeof DEFINITIONS;
export type RuntimeSettings = { [K in RuntimeSettingName]: ReturnType<(typeof DEFINITIONS)[K]["read"]> };
export type RuntimeSource = "saved" | "environment" | "default";
export const runtimeSettingsPatch = z.object(Object.fromEntries(Object.entries(DEFINITIONS).map(([name, definition]) => [name, definition.schema.nullable().optional()])) as { [K in RuntimeSettingName]: z.ZodOptional<z.ZodNullable<(typeof DEFINITIONS)[K]["schema"]>> }).strict();
export type RuntimeSettingsPatch = z.infer<typeof runtimeSettingsPatch>;

let saved: Partial<RuntimeSettings> = {};
const names = Object.keys(DEFINITIONS) as RuntimeSettingName[];

/** The values in force now. */
export function runtime(): RuntimeSettings {
  return Object.fromEntries(names.map(name => [name, saved[name] ?? DEFINITIONS[name].read()])) as RuntimeSettings;
}
/** Where each value comes from, for the settings page: a saved choice, the server's environment, or the built-in default. */
export function runtimeSources(): Record<RuntimeSettingName, RuntimeSource> {
  return Object.fromEntries(names.map(name => [name, saved[name] !== undefined ? "saved" : (process.env[DEFINITIONS[name].env] ?? "").trim() ? "environment" : "default"])) as Record<RuntimeSettingName, RuntimeSource>;
}
function decode(raw: string | null | undefined): Partial<RuntimeSettings> {
  let stored: Record<string, unknown> = {};
  try { const value: unknown = raw ? JSON.parse(raw) : {}; if (value && typeof value === "object" && !Array.isArray(value)) stored = value as Record<string, unknown>; } catch { /* unreadable settings fall back to the environment */ }
  const result: Record<string, unknown> = {};
  for (const name of names) { const parsed = DEFINITIONS[name].schema.safeParse(stored[name]); if (parsed.success) result[name] = parsed.data; }
  return result as Partial<RuntimeSettings>;
}
/** Read the saved choices; called once at start. */
export async function loadRuntimeSettings(): Promise<RuntimeSettings> {
  saved = decode((await db.setting.findUnique({ where: { key: RUNTIME_SETTINGS_KEY } }))?.value);
  return runtime();
}
/** Save choices. `null` for a setting forgets the saved choice, so the environment or the default applies again. Returns the names that changed. */
export async function saveRuntimeSettings(patch: RuntimeSettingsPatch): Promise<RuntimeSettingName[]> {
  const before = runtime(), next: Record<string, unknown> = { ...decode((await db.setting.findUnique({ where: { key: RUNTIME_SETTINGS_KEY } }))?.value) };
  for (const name of names) { const value = patch[name]; if (value === null) delete next[name]; else if (value !== undefined) next[name] = value; }
  const value = JSON.stringify(next);
  await db.setting.upsert({ where: { key: RUNTIME_SETTINGS_KEY }, create: { key: RUNTIME_SETTINGS_KEY, value }, update: { value } });
  saved = decode(value);
  const after = runtime();
  return names.filter(name => before[name] !== after[name]);
}
/** For tests: forget what is held in memory. */
export function resetRuntimeSettings(): void { saved = {}; }
