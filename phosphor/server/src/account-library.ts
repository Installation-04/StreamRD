import { createHash } from "node:crypto";
import { AccountMedia, AccountScan, Prisma } from "@prisma/client";
import { db } from "./db";
import { DEFAULT_SERVER_SETTINGS } from "./settings";
import { PROVIDER_IDS, ProviderCredentials, ProviderError, ProviderId } from "./providers/types";
import { ExistingAccountItem, playAccountItem, scanAccountPage } from "./providers/account-library";

const KEY_FIELDS: Record<string, string> = { realdebrid: "realDebridToken", alldebrid: "allDebridApiKey", premiumize: "premiumizeApiKey", torbox: "torboxApiKey" };
const ACTIVE = ["queued", "scanning"];
const MAX_PAGES = 2000;
const LEASE_MS = 60000;
type Client = Pick<Prisma.TransactionClient, "debridConfig" | "setting">;
export class AccountLibraryError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
function jsonObject(value: string | undefined): Record<string, unknown> {
  try { const parsed = JSON.parse(value ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
/** Local state only; called again inside transactions before committing provider results. */
async function context(userId: string, provider: ProviderId, client: Client = db) {
  const [cfg, settings] = await Promise.all([
    client.debridConfig.findUnique({ where: { userId }, include: { user: { select: { active: true } } } }),
    client.setting.findMany({ where: { key: { in: ["server", "providers"] } } }),
  ]);
  const server = { ...DEFAULT_SERVER_SETTINGS, ...jsonObject(settings.find(row => row.key === "server")?.value) };
  const providers = jsonObject(settings.find(row => row.key === "providers")?.value);
  const flags = providers[provider];
  const enabled = !strings(server.disabledProviders).includes(provider) && !(flags && typeof flags === "object" && (flags as Record<string, unknown>).enabled === false);
  const key = cfg ? (cfg as unknown as Record<string, unknown>)[KEY_FIELDS[provider]] : null;
  const apiKey = typeof key === "string" ? key.trim() : "";
  const override = flags && typeof flags === "object" ? (flags as Record<string, unknown>).baseUrl : null;
  const baseUrl = typeof override === "string" && override.trim() ? override.trim() : undefined;
  const fingerprint = createHash("sha256").update(JSON.stringify([userId, provider, apiKey, baseUrl ?? ""])).digest("hex");
  const timeout = Number(server.providerTimeoutMs);
  const creds: ProviderCredentials = { apiKey, baseUrl, timeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.min(timeout, 15000)) : 15000, deadline: Date.now() + 20000 };
  return { cfg, configured: Boolean(apiKey), enabled, active: cfg?.user.active === true, fingerprint, creds };
}
function current(scan: AccountScan, ctx: Awaited<ReturnType<typeof context>>) {
  return ctx.active && ctx.configured && ctx.enabled && ctx.fingerprint === scan.credentialFingerprint && (!scan.automatic || ctx.cfg?.autoImportLibrary === true);
}
export async function getAccountScanStatus(userId: string) {
  const [cfg, scans, totalImported] = await Promise.all([
    db.debridConfig.findUnique({ where: { userId } }), db.accountScan.findMany({ where: { userId } }), db.accountMedia.count({ where: { userId } }),
  ]);
  const providers = await Promise.all(PROVIDER_IDS.map(async provider => {
    const ctx = await context(userId, provider);
    const stored = scans.find(scan => scan.provider === provider && scan.credentialFingerprint === ctx.fingerprint);
    return { provider, configured: ctx.configured, enabled: ctx.enabled, status: stored?.status ?? "not-started", scanned: stored?.scanned ?? 0, imported: stored?.imported ?? 0, skipped: stored?.skipped ?? 0, error: stored?.error ?? null, updatedAt: stored?.updatedAt.toISOString() ?? null };
  }));
  return { automatic: cfg?.autoImportLibrary !== false, providers, totalImported };
}
export async function currentAccountMediaFilter(userId: string): Promise<Prisma.AccountMediaWhereInput> {
  const valid: Prisma.AccountMediaWhereInput[] = [];
  for (const provider of PROVIDER_IDS) {
    const ctx = await context(userId, provider);
    if (ctx.active && ctx.enabled && ctx.configured) valid.push({ provider, credentialFingerprint: ctx.fingerprint });
  }
  return { userId, OR: valid.length ? valid : [{ id: { in: [] } }] };
}
export async function countReadyAccountMedia(userId: string) {
  return db.accountMedia.count({ where: { AND: [await currentAccountMediaFilter(userId), { phase: "finished" }] } });
}
export async function cancelAccountScan(userId: string, provider: ProviderId) {
  await db.accountScan.updateMany({ where: { userId, provider, status: { in: ACTIVE } }, data: { status: "cancelled", leaseUntil: null, error: null, revision: { increment: 1 } } });
}
/** Enqueue locally only. No request is made to a provider from configuration or setup. */
export async function queueAccountScans(userId: string, options: { provider?: ProviderId; force?: boolean; automatic?: boolean } = {}) {
  const automatic = options.automatic !== false;
  const cfg = await db.debridConfig.findUnique({ where: { userId } });
  if (!cfg) return { queued: 0 };
  if (!cfg.autoImportLibrary) {
    await db.accountScan.updateMany({ where: { userId, automatic: true, status: { in: ACTIVE } }, data: { status: "cancelled", leaseUntil: null, revision: { increment: 1 } } });
    if (automatic) return { queued: 0 };
  }
  let personal: string[] = [];
  try { personal = strings(JSON.parse(cfg.fallbackOrder)); } catch {}
  const order = [...new Set([cfg.primaryProvider, ...personal, ...PROVIDER_IDS])].filter((value): value is ProviderId => PROVIDER_IDS.includes(value as ProviderId));
  let queued = 0;
  for (const provider of options.provider ? [options.provider] : order) {
    const result = await db.$transaction(async tx => {
      const ctx = await context(userId, provider, tx);
      if (!ctx.active || !ctx.configured || !ctx.enabled || (automatic && !ctx.cfg?.autoImportLibrary)) {
        await tx.accountScan.updateMany({ where: { userId, provider, status: { in: ACTIVE } }, data: { status: "cancelled", leaseUntil: null, revision: { increment: 1 } } });
        return false;
      }
      const existing = await tx.accountScan.findUnique({ where: { userId_provider: { userId, provider } } });
      if (existing?.credentialFingerprint === ctx.fingerprint && (!options.force || ACTIVE.includes(existing.status))) return false;
      const data = { status: "queued", cursor: null, credentialFingerprint: ctx.fingerprint, automatic, leaseUntil: null, nextAttemptAt: new Date(), failures: 0, pages: 0, scanned: 0, imported: 0, skipped: 0, error: null };
      await tx.accountScan.upsert({ where: { userId_provider: { userId, provider } }, create: { userId, provider, ...data }, update: { ...data, revision: { increment: 1 } } });
      if (existing && existing.credentialFingerprint !== ctx.fingerprint) await tx.accountMedia.updateMany({ where: { userId, provider, credentialFingerprint: { not: ctx.fingerprint } }, data: { phase: "error", progress: 0 } });
      return true;
    });
    if (result) queued++;
  }
  return { queued };
}
export const syncAccountLibraryConfiguration = (userId: string) => queueAccountScans(userId, { automatic: true });
let importHook: ((items: AccountMedia[]) => Promise<void>) | null = null;
export function setAccountImportHook(hook: ((items: AccountMedia[]) => Promise<void>) | null) { importHook = hook; }
function mediaHint(item: ExistingAccountItem) {
  if (typeof item.providerRef !== "string" || !item.providerRef || item.providerRef.length > 8192 || /[\x00-\x1f]/.test(item.providerRef)) return null;
  const original = typeof item.name === "string" ? item.name.replace(/[\x00-\x1f]/g, " ").trim() : "";
  if (!original || /^(?:https?:|magnet:)/i.test(original)) return null;
  if (/\.(?:nfo|txt|srt|ass|sub|ssa|vtt|pdf|jpe?g|png|webp|gif|mp3|flac|wav|ogg|aac|exe|dmg)$/i.test(original)) return null;
  const filename = original.split(/[\\/]/).at(-1)!.replace(/\.(?:mkv|mp4|m4v|avi|mov|ts|m2ts|webm|mpg|mpeg)$/i, "");
  const yearMatch = /(?:^|[ ._(\-])((?:18|19|20|21)\d{2}|2200)(?=$|[ ._)\-])/.exec(filename);
  const episode = /(?:^|[ ._\-])(?:s\d{1,3}(?:e\d{1,4})?|\d{1,3}x\d{1,4}|season[ ._\-]?\d+)(?=$|[ ._\-])/i.exec(filename);
  const stop = Math.min(yearMatch?.index ?? filename.length, episode?.index ?? filename.length);
  const cleaned = filename.slice(0, stop).replace(/[._]/g, " ").replace(/\s+/g, " ").replace(/^[ ()\[\]-]+|[ ()\[\]-]+$/g, "");
  const name = (cleaned || filename || original).slice(0, 240);
  const phase = ["queued", "downloading", "finished", "error"].includes(item.phase) ? item.phase : "queued";
  const progress = Number.isFinite(item.progress) ? Math.round(Math.max(0, Math.min(item.progress, 100))) : 0;
  return { name, type: episode ? "series" : "movie", year: yearMatch ? Number(yearMatch[1]) : null, phase, progress };
}
/** Process at most one bounded provider page, with a durable exclusive claim. */
export async function runAccountLibraryJob(): Promise<boolean> {
  const now = new Date();
  const candidate = await db.accountScan.findFirst({ where: { status: { in: ACTIVE }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: [{ nextAttemptAt: "asc" }, { updatedAt: "asc" }] });
  if (!candidate) return false;
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const changed = await db.accountScan.updateMany({ where: { id: candidate.id, revision: candidate.revision, status: { in: ACTIVE }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { status: "scanning", leaseUntil, revision: { increment: 1 } } });
  if (!changed.count) return false;
  const scan = { ...candidate, status: "scanning", leaseUntil, revision: candidate.revision + 1 };
  const owned = { id: scan.id, revision: scan.revision, status: "scanning", leaseUntil };
  try {
    if (!PROVIDER_IDS.includes(scan.provider as ProviderId)) throw new AccountLibraryError("The provider is not supported by this server.");
    const provider = scan.provider as ProviderId, ctx = await context(scan.userId, provider);
    if (!current(scan, ctx)) {
      await db.accountScan.updateMany({ where: owned, data: { status: "cancelled", leaseUntil: null, error: "Scan stopped because account or provider configuration changed." } }); return true;
    }
    const page = await scanAccountPage(provider, ctx.creds, scan.cursor ?? undefined);
    if (!Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 8192))) throw new AccountLibraryError("The provider returned an invalid account page.");
    const items = await db.$transaction(async tx => {
      const [claim, fresh] = await Promise.all([tx.accountScan.findUnique({ where: { id: scan.id } }), context(scan.userId, provider, tx)]);
      if (!claim || claim.status !== "scanning" || claim.revision !== scan.revision || claim.leaseUntil?.getTime() !== leaseUntil.getTime()) return [];
      if (!current(scan, fresh)) {
        await tx.accountScan.updateMany({ where: owned, data: { status: "cancelled", leaseUntil: null, error: "Scan stopped because account or provider configuration changed." } }); return [];
      }
      let imported = 0, skipped = 0;
      const importedItems: AccountMedia[] = [];
      for (const item of page.items) {
        const hint = mediaHint(item); if (!hint) { skipped++; continue; }
        const key = { userId: scan.userId, provider, providerRef: item.providerRef };
        const existing = await tx.accountMedia.findUnique({ where: { userId_provider_providerRef: key } });
        const sameSource = existing?.credentialFingerprint === scan.credentialFingerprint;
        if (existing && !sameSource) await tx.metadataRecord.deleteMany({ where: { targetType: "account", targetId: existing.id, ownerId: scan.userId } });
        const update = sameSource ? { phase: hint.phase, progress: hint.progress, credentialFingerprint: scan.credentialFingerprint } : { ...hint, credentialFingerprint: scan.credentialFingerprint };
        const saved = await tx.accountMedia.upsert({ where: { userId_provider_providerRef: key }, create: { ...key, ...hint, credentialFingerprint: scan.credentialFingerprint }, update });
        importedItems.push(saved); if (existing) skipped++; else imported++;
      }
      const incomplete = Boolean(page.warning) || (page.nextCursor !== null && (page.nextCursor === scan.cursor || scan.pages + 1 >= MAX_PAGES));
      await tx.accountScan.updateMany({ where: owned, data: { status: incomplete ? "error" : page.nextCursor ? "queued" : "complete", cursor: page.nextCursor, leaseUntil: null, nextAttemptAt: new Date(), failures: 0, pages: { increment: 1 }, scanned: { increment: page.items.length }, imported: { increment: imported }, skipped: { increment: skipped }, error: incomplete ? "The provider scan could not establish a complete library. Imported items were kept; review the connection and rescan." : null } });
      return importedItems;
    }, { timeout: 15000 });
    if (items.length && importHook) { try { await importHook(items); } catch { /* Metadata discovery can recover queued work; imports remain durable. */ } }
  } catch (error) {
    const failures = scan.failures + 1;
    const denied = error instanceof ProviderError && [401, 403].includes(error.statusCode ?? 0);
    const retry = !denied && failures < 3 && !(error instanceof AccountLibraryError);
    const message = denied ? "The provider rejected the saved credentials. Review your debrid settings." : retry ? "The provider could not be reached. The scan will retry automatically." : "The provider scan could not finish. Existing imports were kept; review the connection and rescan.";
    await db.accountScan.updateMany({ where: owned, data: { status: retry ? "queued" : "error", leaseUntil: null, failures, nextAttemptAt: new Date(Date.now() + (error instanceof ProviderError && error.statusCode === 429 ? 30000 : 2000 * 2 ** (failures - 1))), error: message } });
  }
  return true;
}
export function startAccountLibraryWorker() {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try { if (!stopped) await runAccountLibraryJob(); } catch { /* Runtime checks must not terminate the HTTP server. */ }
    if (!stopped) { timer = setTimeout(() => void tick(), 1500); timer.unref(); }
  };
  timer = setTimeout(() => void tick(), 1000); timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
/** A signed URL is resolved only for an owner-authenticated, explicitly played import. */
export async function playImportedMedia(userId: string, id: string, fileToken?: string, authorize?: () => Promise<void>) {
  if (authorize) await authorize();
  const item = await db.accountMedia.findFirst({ where: { id, userId } });
  if (!item) throw new AccountLibraryError("Library item not found.", 404);
  if (!PROVIDER_IDS.includes(item.provider as ProviderId)) throw new AccountLibraryError("This provider is not supported.", 409);
  const provider = item.provider as ProviderId, ctx = await context(userId, provider);
  if (!ctx.active || !ctx.enabled || !ctx.configured || item.credentialFingerprint !== ctx.fingerprint) throw new AccountLibraryError("The saved provider account changed. Rescan the current account before playing this import.", 409);
  if (authorize) await authorize();
  let result: Awaited<ReturnType<typeof playAccountItem>>;
  try { result = await playAccountItem(provider, ctx.creds, item.providerRef, fileToken); }
  catch (error) {
    const status = error instanceof ProviderError ? error.statusCode : undefined;
    const recoverable: Record<number, string> = { 400: "Choose an available video file from this import.", 404: "This item is no longer available in the provider account. Rescan your private library.", 409: "Video choices changed. Open Play again and choose an available file.", 422: "This item has no selected playable video. Review it in your provider dashboard." };
    throw new AccountLibraryError(status && recoverable[status] ? recoverable[status] : "Playback could not be resolved. Check the provider connection and try again.", status && recoverable[status] ? status : 503);
  }
  const fresh = await context(userId, provider);
  const stillOwned = await db.accountMedia.findFirst({ where: { id, userId, credentialFingerprint: item.credentialFingerprint } });
  if (!stillOwned || !fresh.active || !fresh.enabled || !fresh.configured || fresh.fingerprint !== item.credentialFingerprint) throw new AccountLibraryError("The account changed while resolving playback. Refresh your library and retry.", 409);
  if (authorize) await authorize();
  if (result.stream) await db.accountMedia.updateMany({ where: { id, userId, credentialFingerprint: item.credentialFingerprint }, data: { phase: "finished", progress: 100 } });
  return result;
}
