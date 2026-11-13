/** qBittorrent's Web API is used only for administrator-approved magnets. */
export class RequestClientError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export interface QbitSettings { enabled: boolean; baseUrl: string; username: string; password: string; ownerId: string; shareWithAddons?: boolean; allowBundledAccess?: boolean }
export interface TransferState { ref: string; phase: "queued" | "downloading" | "finished" | "error"; progress: number | null; state: string }
export function validateMagnet(sourceUrl: string): string {
  if (sourceUrl.length > 8192) throw new RequestClientError("Use a valid magnet with a BitTorrent v1 info hash.", 400);
  let url: URL;
  try { url = new URL(sourceUrl); } catch { throw new RequestClientError("Use a valid magnet with a BitTorrent v1 info hash.", 400); }
  const hashes = url.searchParams.getAll("xt").filter(value => /^urn:btih:/i.test(value)).map(value => value.slice(9));
  if (url.protocol !== "magnet:" || hashes.length !== 1) throw new RequestClientError("Use a valid magnet with one BitTorrent v1 info hash.", 400);
  const value = hashes[0];
  if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, buffer = 0; const bytes: number[] = [];
    for (const char of value.toUpperCase()) { buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); } }
    return Buffer.from(bytes).toString("hex");
  }
  throw new RequestClientError("Use a valid magnet with a BitTorrent v1 info hash.", 400);
}
export function normalizeQbitUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%|\\/.test(url.pathname)) throw Error();
    return url.toString().replace(/\/$/, "");
  } catch { throw new RequestClientError("Use an HTTP or HTTPS qBittorrent Web UI URL without credentials, query or fragment.", 400); }
}
function transfer(row: Record<string, unknown>, hash: string): TransferState {
  if (typeof row.hash !== "string" || row.hash.toLowerCase() !== hash || typeof row.state !== "string") throw new RequestClientError("qBittorrent returned an invalid transfer response.");
  const raw = typeof row.progress === "number" && Number.isFinite(row.progress) && row.progress >= 0 && row.progress <= 1 ? row.progress : null;
  const bad = ["error", "missingFiles", "unknown"].includes(row.state);
  const busy = /^(checking|moving|allocating)/i.test(row.state);
  const done = !bad && !busy && ["uploading", "stalledUP", "pausedUP", "stoppedUP", "forcedUP", "queuedUP"].includes(row.state) && raw === 1 && typeof row.completion_on === "number" && row.completion_on > 0;
  const paused = ["pausedDL", "stoppedDL"].includes(row.state), stalled = row.state === "stalledDL";
  const active = ["downloading", "forcedDL"].includes(row.state);
  const state = bad ? "error" : done ? "completed" : paused ? "paused" : stalled ? "waiting_for_peers" : /^checking/.test(row.state) ? "checking" : row.state === "metaDL" ? "fetching_metadata" : active ? "downloading" : "queued";
  return { ref: hash, phase: bad ? "error" : done ? "finished" : active ? "downloading" : "queued", progress: raw === null ? null : Math.floor(raw * 100), state };
}
export class QbitClient {
  private sid = "";
  private readonly base: string;
  private readonly deadline = Date.now() + 20000;
  constructor(private readonly settings: QbitSettings) { this.base = normalizeQbitUrl(settings.baseUrl); }
  private async request(path: string, body?: URLSearchParams) {
    const remaining = Math.min(8000, this.deadline - Date.now());
    if (remaining <= 0) throw new RequestClientError("qBittorrent operation timed out.");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(this.base + path, { method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: { Origin: new URL(this.base).origin, Referer: this.base + "/", ...(this.sid ? { Cookie: `SID=${this.sid}` } : {}), ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, ...(body ? { body } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new RequestClientError("qBittorrent rejected the request. Check its connection and credentials."); }
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new RequestClientError("qBittorrent response exceeded the allowed size."); } chunks.push(value); } }
      return { headers: response.headers, text: Buffer.concat(chunks).toString("utf8") };
    } catch (error) { if (error instanceof RequestClientError) throw error; throw new RequestClientError("Could not reach qBittorrent. Check its connection and retry."); }
    finally { clearTimeout(timer); }
  }
  async login(): Promise<void> {
    const response = await this.request("/api/v2/auth/login", new URLSearchParams({ username: this.settings.username, password: this.settings.password }));
    const sid = /(?:^|[;,]\s*)SID=([A-Za-z0-9+/_=-]{16,128})(?:;|$)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    if (response.text.trim() !== "Ok." || !sid) throw new RequestClientError("qBittorrent authentication failed. Check its saved credentials.");
    this.sid = sid;
  }
  async info(hash: string): Promise<TransferState | null> {
    const response = await this.request(`/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`);
    let rows: unknown;
    try { rows = JSON.parse(response.text); } catch { throw new RequestClientError("qBittorrent returned an invalid transfer response."); }
    if (!Array.isArray(rows) || rows.length > 1) throw new RequestClientError("qBittorrent returned an invalid transfer response.");
    if (!rows.length) return null;
    if (!rows[0] || typeof rows[0] !== "object") throw new RequestClientError("qBittorrent returned an invalid transfer response.");
    return transfer(rows[0], hash);
  }
  async add(magnet: string, requestId: string): Promise<TransferState> {
    const hash = validateMagnet(magnet);
    const existing = await this.info(hash);
    if (existing) return existing; // The exact approved hash is already present; never submit a duplicate.
    const response = await this.request("/api/v2/torrents/add", new URLSearchParams({ urls: magnet, tags: `streamrd-request-${requestId}` }));
    if (response.text.trim() !== "Ok.") throw new RequestClientError("qBittorrent did not confirm the submission. Check the client before retrying.");
    return { ref: hash, phase: "queued", progress: null, state: "queued" };
  }
}
