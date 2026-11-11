/**
 * What a release name says about the file: resolution, source, video format, audio format, HDR and container. These are labels read from the
 * name (the cheap, always-available source); the player reads the real file when it plays and may know better.
 */
export type TagKind = "resolution" | "source" | "video" | "audio" | "hdr" | "container";
export interface MediaTag { kind: TagKind; label: string }

const has = (text: string, pattern: RegExp) => pattern.test(text);
const word = (body: string) => new RegExp(`(?:^|[^a-z0-9])(?:${body})(?:[^a-z0-9]|$)`, "i");

export function resolutionTag(text: string): string | null {
  const found = /(?:^|[^a-z0-9])(4320p|8k|2160p|4k|uhd|1440p|1080[pi]|720p|576p|480p|360p)(?:[^a-z0-9]|$)/i.exec(text)?.[1]?.toLowerCase();
  if (!found) return null;
  if (found === "8k" || found === "4320p") return "8K";
  if (["2160p", "4k", "uhd"].includes(found)) return "4K";
  return found.replace("i", "p");
}

export function mediaTags(release: string | null | undefined): MediaTag[] {
  const text = (release ?? "").replace(/[_]/g, " "), tags: MediaTag[] = [];
  const add = (kind: TagKind, label: string) => { if (!tags.some(tag => tag.kind === kind && tag.label === label)) tags.push({ kind, label }); };
  const resolution = resolutionTag(text); if (resolution) add("resolution", resolution);
  if (has(text, word("remux"))) add("source", "Remux");
  else if (has(text, /(?:blu-?ray|bdrip|brrip|bd-?rip)/i)) add("source", "BluRay");
  else if (has(text, word("web-?dl|web-?rip|web"))) add("source", "WEB");
  else if (has(text, word("hdtv|pdtv"))) add("source", "HDTV");
  else if (has(text, word("dvd-?rip|dvd|dvdr"))) add("source", "DVD");
  else if (has(text, word("cam|hdcam|telesync|ts|hdts"))) add("source", "CAM");
  if (has(text, word("x265|h[ .]?265|hevc"))) add("video", "HEVC");
  else if (has(text, word("x264|h[ .]?264|avc"))) add("video", "H.264");
  else if (has(text, word("av1"))) add("video", "AV1");
  else if (has(text, word("vp9"))) add("video", "VP9");
  else if (has(text, word("xvid|divx"))) add("video", "XviD");
  else if (has(text, word("vc-?1"))) add("video", "VC-1");
  if (has(text, word("10-?bit|hi10p?"))) add("video", "10-bit");
  // Audio, most specific first so DTS-HD MA is not also reported as DTS.
  if (has(text, word("truehd"))) add("audio", "TrueHD");
  if (has(text, word("atmos"))) add("audio", "Atmos");
  if (has(text, word("dts-?hd(?:[ .-]?ma)?"))) add("audio", "DTS-HD");
  else if (has(text, word("dts-?x"))) add("audio", "DTS:X");
  else if (has(text, word("dts"))) add("audio", "DTS");
  if (has(text, word("e-?ac-?3|eac3|dd\\+|ddp(?:[257][ .]?[01])?"))) add("audio", "EAC3");
  else if (has(text, word("ac-?3|dd[257][ .]?[01]?|dd"))) add("audio", "AC3");
  if (has(text, word("aac(?:[257][ .]?[01])?"))) add("audio", "AAC");
  if (has(text, word("flac"))) add("audio", "FLAC");
  if (has(text, word("opus"))) add("audio", "Opus");
  if (has(text, word("mp3"))) add("audio", "MP3");
  if (has(text, word("dolby[ .]?vision|dv|dovi"))) add("hdr", "Dolby Vision");
  if (has(text, word("hdr10\\+"))) add("hdr", "HDR10+");
  else if (has(text, word("hdr10"))) add("hdr", "HDR10");
  else if (has(text, word("hdr"))) add("hdr", "HDR");
  if (has(text, word("hlg"))) add("hdr", "HLG");
  const container = /\.(mkv|mp4|m4v|avi|mov|webm|wmv|ts|m2ts)(?:$|[?#\s])/i.exec(text)?.[1]?.toUpperCase();
  if (container) add("container", container === "M4V" ? "MP4" : container);
  return tags;
}
