import { db } from "./db";

/** Home page options an administrator sets for everyone. Stored in the settings table; no migration. */
const KEY = "home";
export interface HomeSettings { autoplayTrailers: boolean }
export async function getHomeSettings(): Promise<HomeSettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  try { const stored = row ? JSON.parse(row.value) as Partial<HomeSettings> : {}; return { autoplayTrailers: stored.autoplayTrailers === true }; } catch { return { autoplayTrailers: false }; }
}
export async function saveHomeSettings(next: HomeSettings): Promise<HomeSettings> {
  const value = JSON.stringify({ autoplayTrailers: next.autoplayTrailers === true });
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  return getHomeSettings();
}
