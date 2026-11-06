import { createHmac } from "node:crypto";
import { config } from "../config";
import { ProviderError, ProviderId, TorrentFile, TorrentStatus } from "./types";

export interface FileChoice { token: string; name: string; size?: number; format: string; sample: boolean }
export class FileSelectionRequired extends ProviderError {
  sourceIndex = 0;
  constructor(id: ProviderId, public readonly files: FileChoice[]) { super(id, "Choose a video file to play", 409); }
}
export class InvalidFileSelection extends ProviderError {
  constructor(id: ProviderId) { super(id, "This file choice is no longer available. Open the title again to choose a file.", 409); }
}
const format = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? "unknown";
const videoFormats = new Set(["mp4", "m4v", "webm", "ogv", "mkv", "avi", "mov", "ts", "m2ts", "mpg", "mpeg", "wmv"]);
const isSample = (name: string) => /(?:^|[\/ ._-])(?:sample|trailer)(?:$|[\/ ._-])/i.test(name);

export function chooseFile(id: ProviderId, key: string, status: TorrentStatus, token?: string): TorrentFile {
  // Older adapters/fixtures may expose links without file metadata. Never pick
  // the first of multiple unknown links automatically.
  const files: TorrentFile[] = status.files ?? status.links.map((link, index) => ({ id: link, path: status.links.length === 1 ? status.name : `File ${index + 1}`, link }));
  const candidates = files.filter(file => file.link && (videoFormats.has(format(file.path)) || (!status.files && format(file.path) === "unknown")));
  const sign = (file: TorrentFile) => createHmac("sha256", config.jwtSecret).update(JSON.stringify([key, status.id, file.id, file.path, file.size ?? null])).digest("hex");
  if (token) {
    const selected = candidates.find(file => sign(file) === token);
    if (!selected) throw new InvalidFileSelection(id);
    return selected;
  }
  if (!candidates.length) throw new ProviderError(id, "No video files available in this torrent");
  const main = candidates.filter(file => !isSample(file.path));
  if (main.length === 1) return main[0];
  // Do not silently truncate a large pack and hide potentially desired files.
  if (candidates.length > 500) throw new ProviderError(id, "This torrent has more than 500 video files; use a smaller source");
  throw new FileSelectionRequired(id, candidates.map(file => ({ token: sign(file), name: file.path, size: file.size, format: format(file.path), sample: isSample(file.path) })));
}
