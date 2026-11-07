import { createHash, createHmac } from "node:crypto";
import { PROVIDER_IDS, ProviderCredentials, ProviderError, ProviderId, TorrentPhase } from "./types";

export interface ExistingAccountItem {
  providerRef: string;
  name: string;
  phase: TorrentPhase;
  progress: number;
}
export interface AccountPage { items: ExistingAccountItem[]; nextCursor: string | null; warning?: string }
export interface AccountPlayResult {
  stream?: { provider: ProviderId; url: string; filename: string; filesize?: number; mimeType?: string };
  selectionRequired?: boolean;
  files?: Array<{ token: string; name: string; size?: number }>;
  pending?: boolean;
  progress?: number;
}
interface File { id: string; name: string; size?: number; link?: string; direct?: boolean }
interface Context { provider: ProviderId; creds: ProviderCredentials; deadline: number; requests: number }
interface FolderFrame { id: string; offset: number }
type Cursor = { v: 1; p: string; page?: number; previous?: string; after?: string; stack?: FolderFrame[] };
const BASES: Record<string, string> = {
  realdebrid: "https://api.real-debrid.com/rest/1.0", alldebrid: "https://api.alldebrid.com/v4",
  premiumize: "https://www.premiumize.me/api", torbox: "https://api.torbox.app/v1",
};
const PAGE_SIZE = 100, MAX_REMOTE_ITEMS = 10000, MAX_BYTES = 8 * 1024 * 1024;
const VIDEO = /\.(?:mp4|m4v|webm|ogv|mkv|avi|mov|ts|m2ts|mpg|mpeg|wmv)$/i;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const name = (value: unknown): string => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512) : "";
const id = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const size = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const progress = (value: unknown, factor = 1): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * factor))) : 0;
function error(provider: ProviderId, message = "The provider account could not be read; try again later.", status = 503): ProviderError { return new ProviderError(provider, message, status); }
function context(provider: ProviderId, creds: ProviderCredentials): Context {
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) throw error(provider, "This account provider is not supported.", 400);
  if (typeof creds.apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(creds.apiKey)) throw error(provider, "Connect this provider account before scanning or playing its library.", 400);
  const deadline = creds.deadline;
  return { provider, creds, deadline: Math.min(deadline ?? Infinity, Date.now() + 30000), requests: 0 };
}
function decodeCursor(provider: ProviderId, value?: string): Cursor {
  if (value === undefined) return { v: 1, p: provider };
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,8192}$/.test(value)) throw new Error();
    const data = Buffer.from(value, "base64url"); if (data.toString("base64url") !== value) throw new Error();
    const cursor = object(JSON.parse(data.toString("utf8"))) as unknown as Cursor;
    if (cursor.v !== 1 || cursor.p !== provider) throw new Error();
    if (provider === "realdebrid") {
      if (!Number.isInteger(cursor.page) || cursor.page! < 2 || cursor.page! > 1000000 || typeof cursor.previous !== "string" || !/^[a-f0-9]{64}$/.test(cursor.previous)) throw new Error();
    } else if (provider === "premiumize") {
      if (!Array.isArray(cursor.stack) || cursor.stack.length < 1 || cursor.stack.length > 32 || cursor.stack.some(frame => !frame || (frame.id !== "" && !id(frame.id)) || !Number.isInteger(frame.offset) || frame.offset < 0 || frame.offset > MAX_REMOTE_ITEMS)) throw new Error();
      if (new Set(cursor.stack.map(frame => frame.id)).size !== cursor.stack.length) throw new Error();
    } else if (!id(cursor.after)) throw new Error();
    return cursor;
  } catch { throw error(provider, "The account scan cursor is invalid; start a new scan.", 400); }
}
function encodeCursor(provider: ProviderId, data: Omit<Cursor, "v" | "p">): string {
  const value = Buffer.from(JSON.stringify({ v: 1, p: provider, ...data })).toString("base64url");
  if (value.length > 8192) throw error(provider, "The provider folder hierarchy exceeds the supported scan depth.", 422);
  return value;
}
function list(provider: ProviderId, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_REMOTE_ITEMS) throw error(provider, "The provider returned an unsupported or oversized account listing.", 502);
  return value.map(object);
}
function envelopeError(provider: ProviderId, body: Record<string, unknown>): ProviderError {
  // Recognize documented authentication categories without exposing provider
  // messages (which can include API keys or credential-bearing URLs).
  const value = object(body.error).code ?? body.error ?? body.message;
  const code = typeof value === "string" ? value.slice(0, 200) : "";
  if (/AUTH_USER_FREE|NO_PREMIUM|PREMIUM_REQUIRED|SUBSCRIPTION_REQUIRED/i.test(code)) return error(provider, "The provider account requires an active subscription for this operation.", 403);
  if (/^AUTH_|^BAD_TOKEN$|^INVALID_TOKEN$|^TOKEN_EXPIRED$|^INVALID_API_?KEY$|^NO_AUTH$|^UNAUTHORIZED$|not logged in|(?:invalid|wrong|missing|bad) api[ _-]?key/i.test(code)) return error(provider, "The provider rejected account access; reconnect the account.", 401);
  return error(provider, "The provider rejected this account operation; check the account connection.", 502);
}
async function read(ctx: Context, path: string, parameters: Record<string, string> = {}, init: RequestInit = {}): Promise<unknown> {
  if (++ctx.requests > 6) throw error(ctx.provider, "The provider request budget was exceeded; try again later.", 503);
  const timeout = Math.min(ctx.creds.timeoutMs ?? 15000, 15000, ctx.deadline - Date.now());
  if (timeout <= 0) throw error(ctx.provider, "The provider account request timed out; try again later.", 504);
  let url: URL;
  try {
    const defaultBase = ctx.provider === "alldebrid" && path === "/magnet/status" ? "https://api.alldebrid.com/v4.1" : BASES[ctx.provider];
    const base = new URL(ctx.creds.baseUrl ?? defaultBase);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    url = new URL(base.href.replace(/\/+$/, "") + path);
  } catch { throw error(ctx.provider, "The provider endpoint configuration is invalid.", 503); }
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (ctx.provider === "realdebrid" || (ctx.provider as string) === "torbox") headers.set("Authorization", `Bearer ${ctx.creds.apiKey}`);
  else url.searchParams.set("apikey", ctx.creds.apiKey);
  if (ctx.provider === "alldebrid") url.searchParams.set("agent", "phosphor");
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout); timer.unref();
  try {
    const response = await fetch(url, { ...init, headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) throw error(ctx.provider, "The provider request limit was reached; try again later.", 429);
      if ([401, 403].includes(response.status)) throw error(ctx.provider, "The provider rejected account access; reconnect the account and check its subscription.", response.status);
      if (response.status === 404) throw error(ctx.provider, "This item is no longer available in the provider account.", 404);
      throw error(ctx.provider);
    }
    if (response.status === 204) return null;
    if (Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw error(ctx.provider, "The provider account response is too large to scan safely.", 502); }
    const reader = response.body?.getReader(); if (!reader) throw error(ctx.provider, "The provider account response was empty.", 502);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > MAX_BYTES) throw error(ctx.provider, "The provider account response is too large to scan safely.", 502);
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (ctx.provider === "realdebrid") return result;
    const body = object(result);
    if ((ctx.provider as string) === "torbox") {
      if (body.success !== true || body.data === undefined) throw envelopeError(ctx.provider, body);
      return body.data;
    }
    if (body.status !== "success") throw envelopeError(ctx.provider, body);
    if (ctx.provider === "alldebrid") {
      if (body.data === undefined) throw error(ctx.provider, "The provider returned an unsupported account response.", 502);
      return body.data;
    }
    return body;
  } catch (caught) {
    if (caught instanceof ProviderError) throw caught;
    if (controller.signal.aborted) throw error(ctx.provider, "The provider account request timed out; try again later.", 504);
    throw error(ctx.provider);
  } finally { clearTimeout(timer); }
}
function rdPhase(state: unknown): TorrentPhase {
  if (state === "downloaded") return "finished";
  if (["queued", "magnet_conversion", "waiting_files_selection"].includes(String(state))) return "queued";
  if (["downloading", "compressing", "uploading"].includes(String(state))) return "downloading";
  return "error";
}
function adPhase(state: unknown): TorrentPhase { return state === 4 ? "finished" : typeof state === "number" && state >= 5 ? "error" : state === 0 ? "queued" : "downloading"; }
function tbPhase(item: Record<string, unknown>): TorrentPhase {
  const state = item.download_state;
  if (["error", "failed", "missingFiles"].includes(String(state))) return "error";
  if (item.download_finished === true || ["completed", "cached", "seeding"].includes(String(state))) return "finished";
  if (["paused", "stalled (no seeds)", "queued"].includes(String(state))) return "queued";
  return "downloading";
}
function item(provider: ProviderId, value: Record<string, unknown>): ExistingAccountItem | null {
  const ref = id(value.id), title = name(provider === "realdebrid" || provider === "alldebrid" ? value.filename : value.name);
  if (!ref || !title) return null;
  const phase = provider === "realdebrid" ? rdPhase(value.status) : provider === "alldebrid" ? adPhase(value.statusCode) : tbPhase(value);
  const percent = provider === "alldebrid" ? typeof value.size === "number" && value.size > 0 && typeof value.downloaded === "number" ? progress(value.downloaded / value.size, 100) : 0 : progress(value.progress, provider === "realdebrid" ? 1 : 100);
  return { providerRef: ref, name: title, phase, progress: phase === "finished" ? 100 : percent };
}
/** Read existing account references only. No torrent creation, file selection or removal. */
export async function scanAccountPage(provider: ProviderId, creds: ProviderCredentials, cursor?: string): Promise<AccountPage> {
  const ctx = context(provider, creds), state = decodeCursor(provider, cursor);
  if (provider === "realdebrid") {
    const page = state.page ?? 1, raw = await read(ctx, "/torrents", { page: String(page), limit: String(PAGE_SIZE) });
    const rows = raw === null ? [] : list(provider, raw);
    if (rows.length > PAGE_SIZE) throw error(provider, "The provider did not honor account pagination; try again later.", 502);
    const signature = createHash("sha256").update(JSON.stringify(rows.map(row => [row.id, row.filename]))).digest("hex");
    if (rows.length && state.previous === signature) throw error(provider, "The provider repeated an account page; start a new scan later.", 502);
    return { items: rows.map(row => item(provider, row)).filter((value): value is ExistingAccountItem => value !== null), nextCursor: rows.length ? encodeCursor(provider, { page: page + 1, previous: signature }) : null };
  }
  if (provider === "premiumize") {
    const stack = state.stack ?? [{ id: "", offset: 0 }], items: ExistingAccountItem[] = [];
    while (stack.length && items.length < PAGE_SIZE && ctx.requests < 6) {
      const frame = stack[stack.length - 1], body = object(await read(ctx, "/folder/list", frame.id ? { id: frame.id } : {}));
      const rows = list(provider, body.content).filter(row => id(row.id)).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
      if (frame.offset > rows.length) throw error(provider, "The cloud folder changed during scanning; start a new scan.", 409);
      let entered = false;
      while (frame.offset < rows.length && items.length < PAGE_SIZE) {
        const row = rows[frame.offset++], ref = id(row.id)!, title = name(row.name);
        if (row.type === "folder") {
          if (stack.some(parent => parent.id === ref) || stack.length >= 32) throw error(provider, "The cloud folder hierarchy is cyclic or exceeds the supported depth.", 422);
          stack.push({ id: ref, offset: 0 }); entered = true; break;
        }
        if (title && VIDEO.test(title)) items.push({ providerRef: `file:${ref}`, name: title, phase: "finished", progress: 100 });
      }
      if (!entered && frame.offset >= rows.length) stack.pop();
    }
    return { items, nextCursor: stack.length ? encodeCursor(provider, { stack }) : null };
  }
  const raw = provider === "alldebrid" ? object(await read(ctx, "/magnet/status")).magnets : await read(ctx, "/api/torrents/mylist");
  const rows = list(provider, Array.isArray(raw) ? raw : raw ? [raw] : []).filter(row => id(row.id)).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  const remaining = state.after ? rows.filter(row => String(row.id) > state.after!) : rows, selected = remaining.slice(0, PAGE_SIZE);
  return { items: selected.map(row => item(provider, row)).filter((value): value is ExistingAccountItem => value !== null), nextCursor: remaining.length > PAGE_SIZE ? encodeCursor(provider, { after: String(selected[selected.length - 1].id) }) : null };
}
function url(provider: ProviderId, value: unknown): string {
  try { const parsed = new URL(String(value)); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); return parsed.href; }
  catch { throw error(provider, "The provider did not return a usable video link.", 422); }
}
function choices(provider: ProviderId, creds: ProviderCredentials, reference: string, files: File[], token?: string): { file?: File; result?: AccountPlayResult } {
  const candidates = files.filter(file => file.link && VIDEO.test(file.name));
  if (!candidates.length) throw error(provider, "No selected video files are available in this account item. Review it in the provider dashboard.", 422);
  if (candidates.length > 100) throw error(provider, "This item contains more than 100 videos; choose a smaller item in the provider dashboard.", 422);
  const sign = (file: File) => createHmac("sha256", creds.apiKey).update(JSON.stringify([provider, reference, file.id, file.name, file.size ?? null])).digest("hex");
  if (token !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw error(provider, "This video file choice is no longer available; choose a file again.", 409);
    const selected = candidates.find(file => sign(file) === token); if (!selected) throw error(provider, "This video file choice is no longer available; choose a file again.", 409);
    return { file: selected };
  }
  const main = candidates.filter(file => !/(?:^|[\/ ._-])(?:sample|trailer)(?:$|[\/ ._-])/i.test(file.name));
  if (candidates.length === 1 || main.length === 1) return { file: main.length === 1 ? main[0] : candidates[0] };
  return { result: { selectionRequired: true, files: candidates.map(file => ({ token: sign(file), name: file.name, ...(file.size === undefined ? {} : { size: file.size }) })) } };
}
/** Resolve signed links only on an owner's explicit play action; never persists them. */
export async function playAccountItem(provider: ProviderId, creds: ProviderCredentials, providerRef: string, fileToken?: string): Promise<AccountPlayResult> {
  const ctx = context(provider, creds); let reference = providerRef;
  if (provider === "premiumize") reference = providerRef.startsWith("file:") ? providerRef.slice(5) : "";
  if (!id(reference)) throw error(provider, "This account item reference is invalid; rescan the account library.", 400);
  let files: File[] = [], phase: TorrentPhase = "finished", percent = 100;
  if (provider === "realdebrid") {
    const data = object(await read(ctx, `/torrents/info/${encodeURIComponent(reference)}`));
    if (String(data.id) !== reference) throw error(provider, "This item is no longer available in the provider account.", 404);
    phase = rdPhase(data.status); percent = progress(data.progress);
    if (phase === "finished") {
      const all = list(provider, data.files), selected = all.filter(file => file.selected === 1), links = Array.isArray(data.links) ? data.links : [];
      if (links.length !== selected.length) throw error(provider, "The provider's selected files and links do not agree; review the item in its dashboard.", 409);
      files = selected.map((file, index) => ({ id: id(file.id) ?? String(index), name: name(file.path), size: size(file.bytes), link: typeof links[index] === "string" ? links[index] : undefined }));
    }
  } else if (provider === "alldebrid") {
    const body = object(await read(ctx, "/magnet/status", { id: reference })), raw = body.magnets;
    const data = Array.isArray(raw) ? raw.map(object).find(row => String(row.id) === reference) : object(raw);
    if (!data || String(data.id) !== reference) throw error(provider, "This item is no longer available in the provider account.", 404);
    phase = adPhase(data.statusCode); percent = typeof data.size === "number" && data.size > 0 && typeof data.downloaded === "number" ? progress(data.downloaded / data.size, 100) : 0;
    if (phase === "finished") {
      const detail = object(await read(ctx, "/magnet/files", {}, { method: "POST", body: new URLSearchParams({ "id[]": reference }) }));
      const magnet = list(provider, detail.magnets).find(row => String(row.id) === reference);
      if (!magnet || magnet.error) throw error(provider, "The provider's existing files could not be read.", 502);
      let visited = 0;
      const walk = (entries: unknown, prefix = "", depth = 0) => {
        if (depth > 32) throw error(provider, "The provider file tree exceeds the supported depth.", 422);
        for (const entry of list(provider, entries)) {
          if (++visited > 5000) throw error(provider, "The provider file tree exceeds the supported size.", 422);
          const label = name(entry.n), path = prefix + label;
          if (Array.isArray(entry.e)) walk(entry.e, path + "/", depth + 1);
          else if (typeof entry.l === "string") files.push({ id: path, name: path, size: size(entry.s), link: entry.l });
        }
      };
      walk(magnet.files ?? []);
    }
  } else if (provider === "premiumize") {
    const data = object(await read(ctx, "/item/details", { id: reference }));
    if (String(data.id) !== reference) throw error(provider, "This item is no longer available in the provider account.", 404);
    files = [{ id: reference, name: name(data.name), size: size(data.size), link: typeof data.link === "string" ? data.link : undefined, direct: true }];
  } else {
    const raw = await read(ctx, "/api/torrents/mylist", { id: reference }), data = Array.isArray(raw) ? raw.map(object).find(row => String(row.id) === reference) : object(raw);
    if (!data || String(data.id) !== reference) throw error(provider, "This item is no longer available in the provider account.", 404);
    phase = tbPhase(data); percent = progress(data.progress, 100);
    if (phase === "finished") files = list(provider, data.files).map(file => ({ id: id(file.id) ?? "", name: name(file.name) || name(file.short_name), size: size(file.size), link: id(file.id) ? `torbox://torrent/${reference}/${id(file.id)}` : undefined }));
  }
  if (phase === "error") throw error(provider, "This account item is not currently available for playback; review it in the provider dashboard.", 422);
  if (phase !== "finished") return { pending: true, progress: percent };
  const selected = choices(provider, creds, providerRef, files, fileToken); if (selected.result) return selected.result;
  const file = selected.file!; let stream: Record<string, unknown>;
  if (file.direct) stream = { url: file.link };
  else if (provider === "realdebrid") {
    const data = object(await read(ctx, "/unrestrict/link", {}, { method: "POST", body: new URLSearchParams({ link: url(provider, file.link) }) }));
    stream = { url: data.download, filename: data.filename, filesize: data.filesize, mimeType: data.mimeType };
  } else if (provider === "alldebrid") {
    const data = object(await read(ctx, "/link/unlock", { link: url(provider, file.link) })); stream = { url: data.link, filename: data.filename, filesize: data.filesize };
  } else {
    // Resolve the existing pseudo reference directly; never create a web download.
    const data = await read(ctx, "/api/torrents/requestdl", { token: creds.apiKey, torrent_id: reference, file_id: file.id, redirect: "false" });
    stream = { url: data };
  }
  return { stream: { provider, url: url(provider, stream.url), filename: name(stream.filename) || file.name.split(/[\/\\]/).pop() || "Video", ...(size(stream.filesize) === undefined && file.size === undefined ? {} : { filesize: size(stream.filesize) ?? file.size }), ...(typeof stream.mimeType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(stream.mimeType) ? { mimeType: stream.mimeType } : {}) } };
}
