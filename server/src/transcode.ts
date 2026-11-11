import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Response } from "express";

/**
 * Plays files a browser cannot play by converting them on the fly with ffmpeg, the way a media server does.
 *   direct : the browser plays the provider's own link (MP4 with H.264 and AAC).
 *   remux  : repackaged into MP4; video and audio are copied untouched (cheap).
 *   audio  : repackaged into MP4 and the audio converted to AAC (DTS, AC3, TrueHD...); video copied (light).
 *   video  : the video is re-encoded to H.264 as well (HEVC, 10-bit, VC-1...); the heaviest, capped at 1080p.
 * The browser never sees the provider link for a converted stream and never names a URL: it holds an unguessable, short-lived stream id,
 * and ffmpeg is given only the https link the server itself resolved. ffmpeg runs with a protocol allow-list and without a shell.
 */
export type Mode = "direct" | "remux" | "audio" | "video";
export interface Probe { formats: string[]; video: string | null; audio: string | null; pixFmt: string | null; durationSeconds: number; width: number; height: number }
export interface Plan { mode: Mode; probe: Probe | null; reason?: string }

const flag = (name: string, fallback: boolean) => { const value = (process.env[name] ?? "").trim().toLowerCase(); return value ? !["0", "false", "off", "no"].includes(value) : fallback; };
export const transcodeEnabled = () => flag("TRANSCODE", true);
export const videoTranscodeEnabled = () => flag("TRANSCODE_VIDEO", true);
export const maxConversions = () => Math.max(1, Math.min(8, Number.parseInt(process.env.TRANSCODE_MAX ?? "2", 10) || 2));
const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg", ffprobeBin = () => process.env.FFPROBE_PATH || "ffprobe";
const PROTOCOLS = "http,https,tcp,tls,crypto";

/** Only a public http(s) link without credentials is ever handed to ffmpeg. */
export function convertibleUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (flag("TRANSCODE_ALLOW_PRIVATE_HOSTS", false)) return url.href; // for a source on your own network
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (isIP(host) && /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(host)) return null;
    return url.href;
  } catch { return null; }
}

const run = (command: string, args: string[], timeoutMs: number) => new Promise<{ code: number | null; out: string }>(resolve => {
  let out = "", done = false;
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
  child.stdout.on("data", chunk => { if (out.length < 200_000) out += chunk; });
  child.on("error", () => finish(null)); child.on("close", code => finish(code));
});

/** Reads the container, codecs and length of a link with ffprobe; null when it cannot be read or ffprobe is missing. */
export async function probeStream(url: string, timeoutMs = 15_000): Promise<Probe | null> {
  const safe = convertibleUrl(url); if (!safe) return null;
  const { code, out } = await run(ffprobeBin(), ["-v", "error", "-protocol_whitelist", PROTOCOLS, "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,pix_fmt,width,height", "-of", "json", safe], timeoutMs);
  if (code !== 0) return null;
  try {
    const data = JSON.parse(out) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number }> };
    const video = data.streams?.find(stream => stream.codec_type === "video"), audio = data.streams?.find(stream => stream.codec_type === "audio");
    const duration = Number.parseFloat(data.format?.duration ?? "");
    return { formats: (data.format?.format_name ?? "").split(",").map(part => part.trim()).filter(Boolean), video: video?.codec_name ?? null, audio: audio?.codec_name ?? null, pixFmt: video?.pix_fmt ?? null,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0, width: video?.width ?? 0, height: video?.height ?? 0 };
  } catch { return null; }
}

const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]), BROWSER_AUDIO = new Set(["aac", "mp3", "opus"]);
/** What it takes to play these streams in a browser. Pure, so it is tested without ffmpeg. */
export function decideMode(probe: Probe): Mode {
  const eightBit = !probe.pixFmt || !/(?:10|12|14|16)(?:le|be)$/.test(probe.pixFmt);
  const videoOk = probe.video === null || (BROWSER_VIDEO.has(probe.video) && eightBit), audioOk = probe.audio === null || BROWSER_AUDIO.has(probe.audio);
  const mp4 = probe.formats.includes("mp4") || probe.formats.includes("mov");
  if (!videoOk) return "video";
  if (!audioOk) return "audio";
  return mp4 ? "direct" : "remux";
}

/** With no probe (ffprobe missing, or the link was slow) the file name is the only hint. */
export function guessMode(filename: string | undefined): Mode {
  const name = filename ?? "";
  if (/(?:^|[^a-z0-9])(?:hevc|x265|h[. ]?265|av1|vc-?1|xvid|10-?bit|hi10p?)(?:[^a-z0-9]|$)/i.test(name)) return "video";
  if (/\.(?:mp4|m4v)(?:$|[?#])/i.test(name) && !/(?:^|[^a-z0-9])(?:dts|truehd|atmos|e-?ac-?3|ac-?3|dd[p+]?[257])/i.test(name)) return "direct";
  return "audio";
}

/** Chooses how to play a resolved link. Never throws: any failure falls back to the browser playing the link itself. */
export async function planPlayback(url: string, filename: string | undefined): Promise<Plan> {
  if (!transcodeEnabled() || !convertibleUrl(url)) return { mode: "direct", probe: null, reason: "off" };
  const probe = await probeStream(url);
  let mode = probe ? decideMode(probe) : guessMode(filename);
  if (!probe && mode !== "direct" && !(await available())) return { mode: "direct", probe: null, reason: "ffmpeg-missing" };
  if (mode === "video" && !videoTranscodeEnabled()) return { mode: "direct", probe, reason: "video-off" };
  return { mode, probe };
}
let found: boolean | undefined;
async function available() { if (found === undefined || process.env.NODE_ENV === "test") found = (await run(ffmpegBin(), ["-version"], 5000)).code === 0; return found; }

// ---- Streams: short-lived, unguessable ids that stand for one resolved link.
interface Registered { url: string; mode: Exclude<Mode, "direct">; userId: string; expires: number }
const streams = new Map<string, Registered>();
const TTL_MS = 12 * 60 * 60 * 1000, MAX_STREAMS = 500;
export function registerStream(url: string, mode: Exclude<Mode, "direct">, userId: string): string {
  const now = Date.now();
  for (const [key, value] of streams) if (value.expires < now) streams.delete(key);
  while (streams.size >= MAX_STREAMS) { const oldest = streams.keys().next().value; if (oldest === undefined) break; streams.delete(oldest); }
  const id = randomBytes(24).toString("base64url");
  streams.set(id, { url, mode, userId, expires: now + TTL_MS });
  return id;
}

/** ffmpeg's arguments for a mode. The link and the start time are the only variable parts, passed as separate arguments (no shell). */
export function ffmpegArgs(url: string, mode: Exclude<Mode, "direct">, startSeconds: number): string[] {
  const start = Number.isFinite(startSeconds) && startSeconds > 0 ? Math.min(startSeconds, 604_800) : 0;
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", PROTOCOLS, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push("-i", url, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn");
  if (mode === "video") args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-vf", "scale=w='min(1920,iw)':h=-2");
  else args.push("-c:v", "copy");
  if (mode === "remux") args.push("-c:a", "copy"); else args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  args.push("-avoid_negative_ts", "make_zero", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
  return args;
}

let active = 0;
export const activeConversions = () => active;
/** Streams a converted file to the response. Returns false (and answers) when the id is unknown or the server is busy. */
export function streamConverted(id: string, startSeconds: number, res: Response): boolean {
  const entry = streams.get(id);
  if (!entry || entry.expires < Date.now()) { res.status(404).json({ error: "This stream has expired. Open the video again." }); return false; }
  if (active >= maxConversions()) { res.status(503).set("Retry-After", "10").json({ error: "The server is converting as many videos as it is set to. Try again in a moment." }); return false; }
  active += 1;
  let child: ChildProcess | null = null, released = false;
  const release = () => { if (!released) { released = true; active -= 1; } };
  child = spawn(ffmpegBin(), ffmpegArgs(entry.url, entry.mode, startSeconds), { stdio: ["ignore", "pipe", "ignore"] });
  res.status(200).set({ "Content-Type": "video/mp4", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "none" });
  child.stdout!.pipe(res);
  child.on("error", () => { release(); if (!res.headersSent) res.status(503).json({ error: "Conversion is not available on this server." }); else res.destroy(); });
  child.on("close", () => { release(); res.end(); });
  res.on("close", () => { if (child && child.exitCode === null) child.kill("SIGKILL"); release(); });
  return true;
}
