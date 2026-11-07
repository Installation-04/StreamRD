import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export class LibraryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const libraryInput = z.object({
  name: z.string().trim().min(1).max(160),
  year: z.number().int().min(1800).max(2200).optional(),
  type: z.enum(["movie", "episode"]),
  season: z.number().int().min(0).max(999).optional(),
  episode: z.number().int().min(1).max(9999).optional(),
  sourcePath: z.string().min(1).max(2048),
}).refine(x => x.type !== "episode" || (x.season !== undefined && x.episode !== undefined), { message: "Episodes need season and episode numbers" });
export type LibraryInput = z.infer<typeof libraryInput>;
const entrySchema = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), media: libraryInput, libraryPath: z.string(), createdAt: z.string().datetime() });
export type LibraryEntry = z.infer<typeof entrySchema>;
const manifestSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(10000) });
const extensions = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".webm", ".mpg", ".mpeg"]);
const manifestName = ".media-library.json";
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
function relativeDirectory(directory: string): string {
  if (directory === "") return directory;
  if (path.isAbsolute(directory) || directory.includes("\\") || directory.split("/").some(p => p === ".." || p === "." || p === "") || /[\x00-\x1f]/.test(directory) || directory.includes(":")) throw new LibraryError("Use a relative media path within the configured mount");
  return directory;
}
function relativeSource(source: string): string {
  if (!source) throw new LibraryError("Choose a relative video path");
  relativeDirectory(source);
  if (!extensions.has(path.extname(source).toLowerCase())) throw new LibraryError("Choose a supported video file");
  return source;
}
function segment(value: string): string {
  let result = value.normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  while (Buffer.byteLength(result) > 120) result = Array.from(result).slice(0, -1).join("");
  result = result.replace(/[. ]+$/g, "");
  if (!result || result === "." || result === ".." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result)) throw new LibraryError("Choose a usable media name");
  return result;
}
export function libraryPath(media: LibraryInput): string {
  const name = segment(media.name), label = `${name}${media.year ? ` (${media.year})` : ""}`, extension = path.extname(relativeSource(media.sourcePath)).toLowerCase();
  if (media.type === "movie") return path.join("Movies", label, `${label}${extension}`);
  const season = String(media.season).padStart(2, "0"), episode = String(media.episode).padStart(2, "0");
  return path.join("TV Shows", label, `Season ${season}`, `${name} - S${season}E${episode}${extension}`);
}
async function noSymlinkDirectories(directory: string, create: boolean): Promise<void> {
  const resolved = path.resolve(directory), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) { try { await fs.mkdir(current, { mode: 0o755 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LibraryError("Library directories must be real directories, not symlinks", 409);
  }
}

export const libraryBrowseQuery = z.object({
  path: z.string().max(2048).default(""), cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const browseCursor = z.object({ version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().min(1).max(255).refine(value => !/[\/\\\x00-\x1f]/.test(value)) });
export interface LibraryBrowseItem {
  kind: "directory" | "file";
  name: string;
  path: string;
  sizeBytes?: number;
  suggested?: LibraryInput;
}
export interface LibraryBatchResult {
  index: number;
  sourcePath: string;
  status: "exported" | "error";
  entry?: LibraryEntry;
  error?: string;
}
/** Filename hints only. Administrators review these before exporting any files. */
export function suggestLibraryMedia(sourcePath: string): LibraryInput {
  const basename = path.basename(sourcePath, path.extname(sourcePath));
  const episode = /(?:^|[ ._\-])s(\d{1,3})e(\d{1,4})(?=$|[ ._\-])/i.exec(basename)
    ?? /(?:^|[ ._\-])(\d{1,3})x(\d{1,4})(?=$|[ ._\-])/i.exec(basename);
  const yearMatch = /(?:^|[ ._(\-])((?:18|19|20|21)\d{2}|2200)(?=$|[ ._)\-])/.exec(basename);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const stop = Math.min(episode?.index ?? basename.length, yearMatch?.index ?? basename.length);
  const clean = (value: string) => value.replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/^[ \[()\-]+|[ \[()\-]+$/g, "").trim();
  const parent = path.basename(path.dirname(sourcePath));
  const name = (clean(basename.slice(0, stop)) || clean(parent === "." ? basename : parent) || "Untitled").slice(0, 160);
  return {
    name, ...(year ? { year } : {}), type: episode ? "episode" : "movie", sourcePath,
    ...(episode ? { season: Number(episode[1]), episode: Number(episode[2]) } : {}),
  };
}

/** One writer process per export root. Never follows output-directory symlinks. */
export class MediaLibrary {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly settings: () => { sourceRoot: string; exportRoot: string }) {}
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation); this.pending = task.catch(() => {}); return task;
  }
  private async sourceRoots() {
    const cfg = this.settings();
    if (!cfg.sourceRoot || !cfg.exportRoot) throw new LibraryError("Media library export is disabled; configure MEDIA_SOURCE_ROOT and MEDIA_LIBRARY_ROOT", 503);
    if (!path.isAbsolute(cfg.sourceRoot) || !path.isAbsolute(cfg.exportRoot)) throw new LibraryError("Media roots must be absolute filesystem paths", 503);
    const source = await fs.realpath(cfg.sourceRoot).catch(() => { throw new LibraryError("Media source mount is unavailable", 503); });
    const output = path.resolve(cfg.exportRoot);
    if (source === output || inside(source, output) || inside(output, source)) throw new LibraryError("Source and library roots must be separate directories", 503);
    if (!(await fs.stat(source)).isDirectory()) throw new LibraryError("Media source mount must be a directory", 503);
    return { source, output };
  }
  private async roots() {
    const roots = await this.sourceRoots();
    await noSymlinkDirectories(roots.output, true);
    return roots;
  }
  private async read(output: string): Promise<LibraryEntry[]> {
    const file = path.join(output, manifestName);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid manifest");
      const entries = manifestSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))).entries;
      if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(entries.map(e => e.libraryPath)).size !== entries.length || entries.some(e => e.libraryPath !== libraryPath(e.media))) throw new Error("Invalid manifest entries");
      return entries;
    } catch (e) { if (missing(e)) return []; throw new LibraryError("Library manifest is invalid; restore its verified backup before making changes", 409); }
  }
  private async save(output: string, entries: LibraryEntry[]) {
    const temporary = path.join(output, `.media-library-${randomBytes(16).toString("hex")}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, path.join(output, manifestName));
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  private async source(root: string, relative: string): Promise<string> {
    const target = await fs.realpath(path.join(root, relativeSource(relative))).catch(() => { throw new LibraryError("Source video is missing or the mount is unavailable", 409); });
    if (!inside(root, target)) throw new LibraryError("Source resolves outside the configured media mount");
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new LibraryError("Source must be a video file");
    await fs.access(target, constants.R_OK);
    return target;
  }
  private async link(output: string, entry: LibraryEntry, target: string) {
    const file = path.join(output, entry.libraryPath);
    await noSymlinkDirectories(path.dirname(file), true);
    try {
      // Exclusive symlink creation never overwrites another file or library entry.
      await fs.symlink(target, file, "file"); return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if ((await fs.lstat(file)).isSymbolicLink() && await fs.readlink(file) === target) return false;
      throw new LibraryError("A different file already exists at the scanner path", 409);
    }
  }
  browse(input: { path?: string; cursor?: string; limit?: number } = {}) {
    return this.exclusive(async () => {
      const parsed = libraryBrowseQuery.safeParse(input);
      if (!parsed.success) throw new LibraryError("Invalid media browse path, cursor, or page size");
      const { path: relative, cursor, limit } = parsed.data;
      relativeDirectory(relative);
      // Browsing never creates or changes the scanner tree or source mount.
      const { source } = await this.sourceRoots();
      const directory = await fs.realpath(path.join(source, relative)).catch(() => { throw new LibraryError("Media directory is unavailable", 404); });
      if (directory !== source && !inside(source, directory)) throw new LibraryError("Directory resolves outside the configured media mount");
      if (!(await fs.stat(directory)).isDirectory()) throw new LibraryError("Choose a media directory");
      const scope = createHash("sha256").update(JSON.stringify([source, relative, directory])).digest("hex");
      let after = "";
      if (cursor) {
        try {
          const decoded = browseCursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
          if (decoded.scope !== scope) throw new Error("Wrong browse scope");
          after = decoded.after;
        } catch { throw new LibraryError("Invalid cursor for this media directory"); }
      }
      // Retain only the smallest next-page candidates. Remote mounts can have huge
      // directories; sorting the complete directory would defeat bounded paging.
      const candidates: { name: string }[] = [];
      const stream = await fs.opendir(directory);
      for await (const entry of stream) {
        if (entry.name.startsWith(".") || entry.name <= after || (!entry.isDirectory() && !entry.isSymbolicLink() && !(entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())))) continue;
        let low = 0, high = candidates.length;
        while (low < high) { const middle = (low + high) >>> 1; if (candidates[middle].name < entry.name) low = middle + 1; else high = middle; }
        if (low <= limit) { candidates.splice(low, 0, { name: entry.name }); if (candidates.length > limit + 1) candidates.pop(); }
      }
      const page = candidates.slice(0, limit), items: LibraryBrowseItem[] = [];
      for (const entry of page) {
        const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
        try {
          relativeDirectory(relativePath);
          const target = await fs.realpath(path.join(directory, entry.name));
          // Never expose an escaping symlink, arbitrary non-video file, or special file.
          if (!inside(source, target)) continue;
          const stat = await fs.stat(target);
          if (stat.isDirectory()) items.push({ kind: "directory", name: entry.name, path: relativePath });
          else if (stat.isFile() && extensions.has(path.extname(entry.name).toLowerCase()) && extensions.has(path.extname(target).toLowerCase())) {
            await fs.access(target, constants.R_OK);
            items.push({ kind: "file", name: entry.name, path: relativePath, sizeBytes: stat.size, suggested: suggestLibraryMedia(relativePath) });
          }
        } catch { /* An inaccessible or changed child never invalidates the rest of its page. */ }
      }
      const parent = path.posix.dirname(relative);
      const nextCursor = candidates.length > limit ? Buffer.from(JSON.stringify({ version: 1, scope, after: page[page.length - 1].name })).toString("base64url") : null;
      return { path: relative, parentPath: relative ? (parent === "." ? "" : parent) : null, items, nextCursor };
    });
  }
  async addBatch(items: unknown[]) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new LibraryError("Choose between 1 and 100 files per export batch");
    const results: LibraryBatchResult[] = [];
    // Process sequentially, sharing the existing single-writer queue with manual
    // exports. An invalid/colliding item does not discard earlier successful work.
    for (const [index, input] of items.entries()) {
      const raw = input as { sourcePath?: unknown } | null;
      const sourcePath = typeof raw?.sourcePath === "string" ? raw.sourcePath : "";
      const parsed = libraryInput.safeParse(input);
      if (!parsed.success) { results.push({ index, sourcePath, status: "error", error: "Review the file name, type, path, and episode numbers" }); continue; }
      try { results.push({ index, sourcePath, status: "exported", entry: await this.add(parsed.data) }); }
      catch (e) { results.push({ index, sourcePath, status: "error", error: e instanceof LibraryError ? e.message : "Could not export this file; check mount access and storage permissions" }); }
    }
    const exported = results.filter(item => item.status === "exported").length;
    return { results, summary: { exported, failed: results.length - exported } };
  }
  /** Bounded descriptors for metadata discovery; never stats every mounted video. */
  metadataTargets(cursor = "", limit = 100) {
    return this.exclusive(async () => {
      const configured = this.settings();
      if (!configured.sourceRoot || !configured.exportRoot) return [];
      const { output } = await this.roots();
      return (await this.read(output)).filter(entry => entry.id > cursor)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .slice(0, Math.max(1, Math.min(101, limit)))
        .map(entry => ({ targetType: "library" as const, targetId: entry.id, name: entry.media.name,
          mediaType: entry.media.type === "episode" ? "series" as const : "movie" as const, year: entry.media.year ?? null }));
    });
  }
  metadataTarget(id: string) {
    return this.exclusive(async () => {
      const { output } = await this.roots();
      const entry = (await this.read(output)).find(item => item.id === id);
      return entry ? { targetType: "library" as const, targetId: entry.id, name: entry.media.name,
        mediaType: entry.media.type === "episode" ? "series" as const : "movie" as const, year: entry.media.year ?? null } : null;
    });
  }
  list() {
    return this.exclusive(async () => {
      const configured = this.settings();
      if (!configured.sourceRoot || !configured.exportRoot) return { enabled: false, entries: [] };
      const { source, output } = await this.roots(), entries = await this.read(output);
      const checked = [];
      for (const entry of entries) {
        let sourceAvailable = false, linked = false;
        try {
          const target = await this.source(source, entry.media.sourcePath); sourceAvailable = true;
          await noSymlinkDirectories(path.dirname(path.join(output, entry.libraryPath)), false);
          linked = await fs.readlink(path.join(output, entry.libraryPath)) === target;
        } catch { /* Missing mounts/links remain visible; listing never deletes media. */ }
        checked.push({ ...entry, sourceAvailable, linked });
      }
      return { enabled: true, sourceRoot: source, exportRoot: output, entries: checked };
    });
  }
  add(input: LibraryInput) {
    return this.exclusive(async () => {
      const media = libraryInput.parse(input), { source, output } = await this.roots(), entries = await this.read(output);
      const target = await this.source(source, media.sourcePath);
      // Store the canonical mount-relative target, preserving the actual file suffix.
      media.sourcePath = path.relative(source, target);
      const scannerPath = libraryPath(media);
      const existing = entries.find(e => e.libraryPath === scannerPath);
      if (existing) {
        if (existing.media.sourcePath !== media.sourcePath) throw new LibraryError("That scanner path already exports another source", 409);
        await this.link(output, existing, target); return existing;
      }
      if (entries.length >= 10000) throw new LibraryError("Library entry limit reached", 409);
      const entry = { id: randomBytes(16).toString("hex"), media, libraryPath: scannerPath, createdAt: new Date().toISOString() };
      // Do not adopt an unmanaged symlink, even when it happens to have the same target.
      try { await fs.lstat(path.join(output, scannerPath)); throw new LibraryError("Scanner path already exists outside this library manifest", 409); } catch (e) { if (!missing(e)) throw e; }
      await this.link(output, entry, target);
      try { await this.save(output, [...entries, entry]); }
      catch (e) { if (await fs.readlink(path.join(output, scannerPath)).catch(() => "") === target) await fs.unlink(path.join(output, scannerPath)); throw e; }
      return entry;
    });
  }
  remove(id: string) {
    return this.exclusive(async () => {
      const { source, output } = await this.roots(), entries = await this.read(output), entry = entries.find(e => e.id === id);
      if (!entry) throw new LibraryError("Library entry not found", 404);
      const file = path.join(output, entry.libraryPath), target = path.join(source, relativeSource(entry.media.sourcePath));
      try {
        await noSymlinkDirectories(path.dirname(file), false);
        const stat = await fs.lstat(file);
        if (!stat.isSymbolicLink() || await fs.readlink(file) !== target) throw new LibraryError("Export was changed externally; refusing to remove it", 409);
        await fs.unlink(file);
      } catch (e) { if (!missing(e)) throw e; }
      // Remove only the managed link. Keep source media and surrounding directories.
      await this.save(output, entries.filter(e => e.id !== id));
    });
  }
  repair() {
    return this.exclusive(async () => {
      const { source, output } = await this.roots(), entries = await this.read(output);
      const results: { id: string; status: "ready" | "repaired" | "unavailable" | "conflict" }[] = [];
      for (const entry of entries) {
        let target: string;
        try { target = await this.source(source, entry.media.sourcePath); }
        catch { results.push({ id: entry.id, status: "unavailable" }); continue; }
        try { results.push({ id: entry.id, status: await this.link(output, entry, target) ? "repaired" : "ready" }); }
        catch { results.push({ id: entry.id, status: "conflict" }); }
      }
      return results;
    });
  }
}
