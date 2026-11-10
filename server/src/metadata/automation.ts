import { createHash } from "node:crypto";
import { MetadataRecord, Prisma } from "@prisma/client";
import { db } from "../db";
import { config } from "../config";
import { fetchMetadata, searchMetadata } from "./providers";
import { getMetadataSettings } from "./settings";
import { MetadataCandidate, MetadataDetails, MetadataError, MetadataSettings } from "./types";
import { applyTargetMetadata, LOCK_FIELDS, metadataTarget, metadataTargets, MetadataTarget, TargetType, TARGET_TYPES } from "./targets";

export class MetadataOperationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function storedMetadata(value: string): MetadataDetails | null {
  try {
    const data = JSON.parse(value);
    return data && ["tmdb", "omdb"].includes(data.provider) && typeof data.id === "string" && typeof data.name === "string" &&
      ["movie", "series"].includes(data.type) && Array.isArray(data.genres) && Array.isArray(data.cast) && typeof data.fetchedAt === "string" ? Object.fromEntries([
        "provider", "id", "type", "name", "year", "posterUrl", "description", "genres", "backdropUrl", "cast", "runtimeMinutes", "rating", "ratingSource", "contentRating", "imdbId", "tmdbId", "providerUrl", "fetchedAt",
      ].map(key => [key, data[key]])) as unknown as MetadataDetails : null;
  } catch { return null; }
}
export function lockedFields(value: string): string[] {
  try { const fields = JSON.parse(value); return Array.isArray(fields) ? [...new Set(fields.filter((field): field is typeof LOCK_FIELDS[number] => LOCK_FIELDS.includes(field)))] : []; }
  catch { return []; }
}
export function metadataView(record: MetadataRecord) {
  return { id: record.id, targetType: record.targetType, targetId: record.targetId, name: record.name, mediaType: record.mediaType, year: record.year,
    status: record.status, data: storedMetadata(record.data), lockedFields: lockedFields(record.lockedFields), revision: record.revision,
    error: record.error, updatedAt: record.updatedAt.toISOString(), attempts: record.attempts };
}
export const recordFor = (type: TargetType, id: string) => db.metadataRecord.findUnique({ where: { targetType_targetId: { targetType: type, targetId: id } } });
function configured(settings: MetadataSettings, provider = settings.provider) { return Boolean(provider === "tmdb" ? settings.tmdbApiKey : settings.omdbApiKey); }
function sameProviderSettings(before: MetadataSettings, after: MetadataSettings, provider: "tmdb" | "omdb") {
  return before.language === after.language && (provider === "tmdb" ? before.tmdbApiKey === after.tmdbApiKey : before.omdbApiKey === after.omdbApiKey);
}
function selectedMatch(value: string): Pick<MetadataCandidate, "provider" | "id" | "type"> | null {
  try {
    const item = JSON.parse(value)?.selection;
    return item && ["movie", "series"].includes(item.type) &&
      ((item.provider === "tmdb" && /^[1-9]\d{0,9}$/.test(item.id)) || (item.provider === "omdb" && /^tt\d{7,10}$/.test(item.id))) ? item : null;
  } catch { return null; }
}
export async function requireTarget(type: TargetType, id: string) {
  if (!TARGET_TYPES.includes(type) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new MetadataOperationError("Unknown metadata target", 404);
  const target = await metadataTarget(type, id);
  if (!target) throw new MetadataOperationError("Media entry no longer exists", 404);
  return target;
}
/** Enqueue only local data. Catalog creation and file exports never wait for upstream HTTP. */
export async function queueTarget(target: MetadataTarget, manual: boolean, force = false, settings?: MetadataSettings) {
  const preferences = settings ?? await getMetadataSettings();
  if (!manual && (!preferences.automatic || !configured(preferences))) return null;
  const existing = await recordFor(target.targetType, target.targetId);
  const source = existing ? storedMetadata(existing.data) ?? selectedMatch(existing.data) : null;
  if (manual && !configured(preferences, source?.provider ?? preferences.provider)) throw new MetadataOperationError("Configure the metadata provider before starting a scan or refresh");
  if (existing && !force) {
    if (!manual && ["error", "unmatched", "review"].includes(existing.status)) return null;
    const refreshedAt = storedMetadata(existing.data)?.fetchedAt;
    const lastRefresh = refreshedAt && Number.isFinite(Date.parse(refreshedAt)) ? Date.parse(refreshedAt) : existing.updatedAt.getTime();
    const due = existing.status === "matched" && lastRefresh + preferences.refreshDays * 86400000 <= Date.now();
    if (!due && !["error", "unmatched"].includes(existing.status)) return null;
  }
  const input = { name: target.name.slice(0, 512), mediaType: target.mediaType, year: target.year, status: "queued",
    ownerId: target.ownerId ?? null, requestedBy: manual ? "manual" : "automatic", attempts: 0, nextAttemptAt: new Date(), leaseUntil: null, error: null };
  if (!existing) {
    try { return await db.metadataRecord.create({ data: { ...input, targetType: target.targetType, targetId: target.targetId } }); }
    catch (error) { if ((error as { code?: string }).code === "P2002") return null; throw error; }
  }
  const changed = await db.metadataRecord.updateMany({ where: { id: existing.id, revision: existing.revision }, data: { ...input, revision: { increment: 1 } } });
  return changed.count ? recordFor(target.targetType, target.targetId) : null;
}
export async function queueAutomaticTargets(targets: MetadataTarget[]) {
  const settings = await getMetadataSettings();
  if (!settings.automatic || !configured(settings)) return;
  for (const target of targets.slice(0, 100)) await queueTarget(target, false, false, settings);
}
export async function scanMetadata(type: TargetType, cursor = "", limit = 100, manual = true) {
  if (!TARGET_TYPES.includes(type)) throw new MetadataOperationError("This product has no catalog; choose the mounted library");
  const settings = await getMetadataSettings();
  if (!configured(settings)) throw new MetadataOperationError("Configure the selected metadata provider before scanning");
  const page = await metadataTargets(type, cursor, limit + 1);
  let queued = 0;
  for (const target of page.slice(0, limit)) if (await queueTarget(target, manual, false, settings)) queued++;
  return { queued, nextCursor: page.length > limit ? page[limit - 1].targetId : null };
}
function normalized(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const RELEASE_TAG = /(?:^|\s)(?:480p|576p|720p|1080p|1080i|2160p|4k|uhd|web ?dl|webrip|bluray|blu ray|brrip|bdrip|dvdrip|hdrip|hdtv|remux|x264|x265|h ?264|h ?265|hevc|avc|xvid|10 ?bit|hdr10?|dts(?: ?hd(?: ?ma)?)?|truehd|atmos|ddp? ?\d(?: \d)?|ac3|eac3|flac|multi|dual|proper|repack|rerip|internal|limited|extended|unrated|uncut|remastered|directors? cut|theatrical|imax|criterion|s\d{1,3}e\d{1,4}|\d{1,3}x\d{1,4})(?=\s|$)/gi;
export interface MatchPlan { query: string; year: number | null }
/** Release names put the title first, then year, edition and quality tags; cut where the title ends. */
export function matchPlans(name: string, hintYear?: number | null): MatchPlan[] {
  const text = name.replace(/\.(mkv|mp4|m4v|avi|mov|webm)$/i, "").replace(/[._]+/g, " ").replace(/[\[\](){}]/g, " ").replace(/\s+/g, " ").trim();
  let tag = -1;
  for (const found of text.matchAll(RELEASE_TAG)) { const at = found.index + (found[0].startsWith(" ") ? 1 : 0); if (at > 0) { tag = at; break; } }
  const beforeTag = text.slice(0, tag >= 0 ? tag : text.length).trim().slice(0, 160);
  const limit = new Date().getFullYear() + 1;
  const years = [...text.matchAll(/(?:^|\s)((?:19|20)\d{2})(?=\s|$)/g)]
    .map(found => ({ at: found.index + (found[0].startsWith(" ") ? 1 : 0), value: Number(found[1]) }))
    .filter(year => year.at > 0 && year.value <= limit && (tag < 0 || year.at < tag));
  const chosen = hintYear != null ? years.filter(year => year.value === hintYear).pop() : years.pop();
  const cut = chosen ? text.slice(0, chosen.at).trim().slice(0, 160) : "";
  if (hintYear != null) return [{ query: cut || beforeTag, year: hintYear }];
  const plans: MatchPlan[] = [];
  if (chosen && cut) plans.push({ query: cut, year: chosen.value });
  if (beforeTag && !plans.some(plan => plan.query === beforeTag)) plans.push({ query: beforeTag, year: null });
  return plans.length ? plans : [{ query: beforeTag || text.slice(0, 160), year: null }];
}
export function metadataQuery(name: string, year?: number | null): string { return matchPlans(name, year)[0].query; }
/** Ambiguity never becomes an arbitrary first-result match. */
export function confidentMatch(target: MetadataTarget, candidates: MetadataCandidate[], plan?: MatchPlan) {
  const typed = candidates.filter(candidate => candidate.type === target.mediaType);
  if (/^tt\d{7,10}$/.test(target.name.trim()) && typed.length === 1) return typed[0];
  const query = plan?.query ?? metadataQuery(target.name, target.year), year = plan ? plan.year : target.year;
  const same = typed.filter(candidate => normalized(candidate.name) === normalized(query));
  if (year !== null) {
    const exact = same.filter(candidate => candidate.year === year);
    if (exact.length) return exact.length === 1 ? exact[0] : null;
    // Files and databases often disagree by a year (festival vs. release date); accept only a single near match.
    const near = same.filter(candidate => candidate.year !== null && Math.abs(candidate.year - year) <= 1);
    return near.length === 1 ? near[0] : null;
  }
  // No year known: a single exact title is enough; remakes (several exact titles) still need review.
  return same.length === 1 ? same[0] : null;
}
function keptLibraryFields(details: MetadataDetails, previous: MetadataDetails | null, locks: string[], target: MetadataTarget): MetadataDetails {
  const result = { ...details };
  const initial = previous ?? { name: target.name, year: target.year, description: "", genres: [], posterUrl: null, backdropUrl: null };
  for (const field of LOCK_FIELDS) if (locks.includes(field)) Object.assign(result, { [field]: initial[field] });
  return result;
}
async function commitMatch(record: MetadataRecord, target: MetadataTarget, details: MetadataDetails, manual: boolean) {
  if (details.type !== target.mediaType) throw new MetadataOperationError("The selected match has a different media type; edit the catalog type before matching");
  return db.$transaction(async tx => {
    const live = await tx.metadataRecord.findUnique({ where: { id: record.id } });
    if (!live || live.revision !== record.revision) throw new MetadataOperationError("Metadata changed while this request was running; refresh and try again", 409);
    const locks = lockedFields(live.lockedFields), previous = storedMetadata(live.data);
    let applied: Record<string, unknown> = {};
    try { const saved = JSON.parse(live.data)?._applied; if (saved && typeof saved === "object" && !Array.isArray(saved)) for (const field of LOCK_FIELDS) if (Object.prototype.hasOwnProperty.call(saved, field)) applied[field] = saved[field]; } catch {}
    const managed = await applyTargetMetadata(tx, target, details, previous, locks, manual, applied);
    return tx.metadataRecord.update({ where: { id: live.id }, data: { data: JSON.stringify({ ...(target.targetType !== "catalog" ? keptLibraryFields(details, previous, locks, target) : details), _applied: managed }),
      status: "matched", name: target.targetType !== "library" && !locks.includes("name") && typeof managed.name === "string" ? managed.name : target.name,
      mediaType: target.mediaType, year: target.targetType !== "library" && !locks.includes("year") && typeof managed.year === "number" ? managed.year : target.year, error: null, leaseUntil: null, revision: { increment: 1 } } });
  });
}
export async function matchMetadata(type: TargetType, id: string, selection: { provider: "tmdb" | "omdb"; id: string; type: "movie" | "series"; expectedRevision?: number }) {
  const target = await requireTarget(type, id);
  if (selection.type !== target.mediaType) throw new MetadataOperationError("Choose a match with the same movie/series type");
  let record = await recordFor(type, id);
  if (selection.expectedRevision !== undefined && record?.revision !== selection.expectedRevision) throw new MetadataOperationError("Metadata changed; refresh and try again", 409);
  if (!record) record = await db.metadataRecord.upsert({ where: { targetType_targetId: { targetType: type, targetId: id } },
    create: { ...target, status: "unmatched", requestedBy: "manual" }, update: {} });
  const preferences = await getMetadataSettings();
  const details = await fetchMetadata(selection, preferences);
  if (!sameProviderSettings(preferences, await getMetadataSettings(), selection.provider)) throw new MetadataOperationError("Metadata provider settings changed; refresh and try again", 409);
  // Recheck file/catalog existence after network I/O; do not resurrect removed media.
  const currentTarget = await requireTarget(type, id);
  return commitMatch(record, currentTarget, details, true);
}
export async function setMetadataLocks(type: TargetType, id: string, fields: string[], expectedRevision?: number) {
  const target = await requireTarget(type, id);
  let record = await recordFor(type, id);
  if (expectedRevision !== undefined && record?.revision !== expectedRevision) throw new MetadataOperationError("Metadata changed; refresh and try again", 409);
  if (!record) record = await db.metadataRecord.create({ data: { ...target, status: "unmatched", requestedBy: "manual" } });
  const changed = await db.metadataRecord.updateMany({ where: { id: record.id, revision: record.revision }, data: { lockedFields: JSON.stringify([...new Set(fields)]),
    status: record.status === "processing" ? "queued" : record.status, leaseUntil: null, revision: { increment: 1 } } });
  if (!changed.count) throw new MetadataOperationError("Metadata changed; refresh and try again", 409);
  return (await recordFor(type, id))!;
}
/** A manual catalog identity edit invalidates stale provider identity; no source edits are inferred. */
export async function protectCatalogEdits(id: string, fields: string[], identityChanged: boolean, transaction?: Prisma.TransactionClient) {
  const connection = transaction ?? db;
  const changedFields = fields.filter(field => LOCK_FIELDS.includes(field as typeof LOCK_FIELDS[number]));
  if (!changedFields.length && !identityChanged) return;
  let record = await connection.metadataRecord.findUnique({ where: { targetType_targetId: { targetType: "catalog", targetId: id } } });
  if (!record) {
    const title = await connection.title.findUnique({ where: { id } });
    const target = title ? { targetType: "catalog" as const, targetId: id, name: title.name, mediaType: title.type === "series" ? "series" as const : "movie" as const, year: title.year } : null;
    if (!target) return;
    record = await connection.metadataRecord.upsert({ where: { targetType_targetId: { targetType: "catalog", targetId: id } }, create: { ...target, status: "queued", requestedBy: "automatic", lockedFields: JSON.stringify(changedFields) }, update: {} });
  }
  const locks = [...new Set([...lockedFields(record.lockedFields), ...changedFields])];
  await connection.metadataRecord.updateMany({ where: { id: record.id, revision: record.revision }, data: { lockedFields: JSON.stringify(locks), revision: { increment: 1 },
    ...(identityChanged ? { status: "review", data: "{}", leaseUntil: null, error: "The title identity changed. Review its metadata match." } : record.status === "processing" ? { status: "queued", leaseUntil: null } : {}) } });
}
/** One leased, revision-guarded job per tick; callers can use this directly for deterministic tests. */
export async function runMetadataJob(now = new Date()) {
  const settings = await getMetadataSettings();
  if (!settings.tmdbApiKey && !settings.omdbApiKey) return false;
  const eligible = { AND: [settings.automatic ? {} : { requestedBy: "manual" }, { OR: [
    { status: "queued", nextAttemptAt: { lte: now } }, { status: "processing", leaseUntil: { lte: now } },
  ] }] };
  const hash = (provider: "tmdb" | "omdb") => createHash("sha256").update(provider === "tmdb" ? settings.tmdbApiKey : settings.omdbApiKey).digest("hex");
  const cooldowns = await db.setting.findMany({ where: { key: { in: ["metadata.cooldown.tmdb", "metadata.cooldown.omdb"] } } });
  const blocked = new Set<string>();
  for (const row of cooldowns) {
    try {
      const provider = row.key.endsWith(".omdb") ? "omdb" : "tmdb", saved = JSON.parse(row.value);
      if (saved.credentialHash === hash(provider) && Number.isFinite(saved.until) && saved.until > now.getTime() && saved.until <= now.getTime() + 86400000) blocked.add(provider);
    } catch {}
  }
  const candidates = await db.metadataRecord.findMany({ where: eligible, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }], take: 100 });
  const record = candidates.find(item => !blocked.has((storedMetadata(item.data) ?? selectedMatch(item.data))?.provider ?? settings.provider));
  if (!record) return false;
  const claimed = await db.metadataRecord.updateMany({ where: { ...eligible, id: record.id, revision: record.revision }, data: { status: "processing", leaseUntil: new Date(now.getTime() + 90000), attempts: { increment: 1 }, revision: { increment: 1 } } });
  if (!claimed.count) return false;
  const job = { ...record, revision: record.revision + 1, attempts: record.attempts + 1 };
  const update = (data: Parameters<typeof db.metadataRecord.updateMany>[0]["data"]) => db.metadataRecord.updateMany({ where: { id: job.id, revision: job.revision, status: "processing" }, data });
  try {
    const target = await requireTarget(job.targetType as TargetType, job.targetId);
    const previous = storedMetadata(job.data);
    let candidate: Pick<MetadataCandidate, "provider" | "id" | "type"> | null = previous ?? selectedMatch(job.data);
    const pinned = Boolean(candidate);
    const stillCurrent = async () => {
      const live = await getMetadataSettings();
      return (job.requestedBy !== "automatic" || live.automatic) && (pinned || settings.provider === live.provider) && sameProviderSettings(settings, live, candidate?.provider ?? settings.provider);
    };
    if (!candidate) {
      let found = 0;
      for (const plan of matchPlans(target.name, target.year).slice(0, 2)) {
        const candidates = await searchMetadata({ query: plan.query, type: target.mediaType, ...(plan.year !== null ? { year: plan.year } : {}) }, settings);
        found += candidates.length;
        candidate = confidentMatch(target, candidates, plan);
        if (candidate) break;
      }
      if (!candidate) {
        await update({ status: found ? "review" : "unmatched", error: found ? "Review the possible matches before applying metadata." : "No matching metadata found. Try a different title or year.", leaseUntil: null, revision: { increment: 1 } });
        return true;
      }
    }
    if (!(await stillCurrent())) {
      await update({ status: "queued", leaseUntil: null, revision: { increment: 1 } }); return true;
    }
    if (job.targetType === "account") await requireTarget("account", job.targetId);
    const details = await fetchMetadata({ ...candidate, refresh: true }, settings);
    if (!(await stillCurrent())) {
      await update({ status: "queued", leaseUntil: null, revision: { increment: 1 } }); return true;
    }
    const currentTarget = await requireTarget(job.targetType as TargetType, job.targetId);
    await commitMatch(job, currentTarget, details, false);
  } catch (error) {
    const conflict = error instanceof MetadataOperationError && error.status === 409;
    if (!conflict) {
      let cooldownUntil = 0;
      if (error instanceof MetadataError && error.code === "metadata-rate-limited") {
        const provider = (storedMetadata(job.data) ?? selectedMatch(job.data))?.provider ?? settings.provider;
        cooldownUntil = now.getTime() + (provider === "omdb" ? 3600000 : 300000);
        const key = `metadata.cooldown.${provider}`, value = JSON.stringify({ until: cooldownUntil, credentialHash: hash(provider) });
        await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
      const retry = error instanceof MetadataError && ["metadata-unavailable", "metadata-rate-limited", "metadata-busy"].includes(error.code) && job.attempts < 3;
      const message = error instanceof MetadataError || error instanceof MetadataOperationError ? error.message : "Metadata lookup failed. Check the provider configuration and try again.";
      await update({ status: retry ? "queued" : "error", error: message, leaseUntil: null,
        nextAttemptAt: new Date(Math.max(cooldownUntil, now.getTime() + 30000 * 2 ** Math.min(job.attempts, 6))), revision: { increment: 1 } });
    }
  }
  return true;
}
export function startMetadataWorker() {
  let busy = false, lastDiscovery = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const settings = await getMetadataSettings();
      if (settings.automatic && configured(settings) && Date.now() - lastDiscovery >= 20000) {
        lastDiscovery = Date.now();
        for (const type of TARGET_TYPES) {
          if (type === "library" && (!config.mediaSourceRoot || !config.mediaLibraryRoot)) continue;
          const key = `metadata.discovery.${type}`;
          const saved = await db.setting.findUnique({ where: { key } });
          const cursor = saved && /^[A-Za-z0-9_-]{0,128}$/.test(saved.value) ? saved.value : "";
          try {
            const page = await scanMetadata(type, cursor, 250, false);
            await db.setting.upsert({ where: { key }, create: { key, value: page.nextCursor ?? "" }, update: { value: page.nextCursor ?? "" } });
          } catch { /* An unavailable optional mount never blocks catalog jobs. */ }
        }
      }
      // Several jobs per tick so a large imported library is matched in minutes rather than hours.
      for (let job = 0; job < 6; job++) if (!(await runMetadataJob())) break;
    } catch { /* No secret-bearing upstream/SQLite exceptions enter product logs. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), 2000); timer.unref(); void tick();
  return () => clearInterval(timer);
}
