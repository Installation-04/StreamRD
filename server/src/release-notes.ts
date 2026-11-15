import { runtime } from "./runtime-settings";
import { version } from "../package.json";
import { PRODUCT } from "./product";
import { isNewer } from "./maintenance";

/**
 * What changed in each release, for the Updates panel: the notes written for every release, cut into sections of plain text. Nothing here is
 * ever passed on as HTML or markdown, so what a release page says cannot put markup into the app. They come from the same release page the
 * update check already asks, and only when that check is turned on.
 */
export interface NoteBlock { kind: "item" | "text"; text: string }
export interface NoteSection { heading: string; blocks: NoteBlock[] }
export interface ReleaseNotes { version: string; title: string; publishedAt: string | null; url: string | null; sections: NoteSection[] }
const UPDATE_SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const plain = (value: string) => value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]{1,3}/g, "").replace(/\s+/g, " ").trim().slice(0, 700);

/** The release notes as sections: a "# " title, "## " headings, "- " items and paragraphs. */
export function parseReleaseNotes(body: string): { title: string; sections: NoteSection[] } {
  let title = ""; const sections: NoteSection[] = []; let section: NoteSection | null = null, lastItem: NoteBlock | null = null;
  for (const raw of body.replace(/\r/g, "").split("\n").slice(0, 400)) {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line)) { if (!title) title = plain(line.replace(/^#\s+/, "")).replace(/^[^—-]*\bv?\d+\.\d+\.\d+\s*[—-]\s*/, ""); continue; }
    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading) { section = { heading: plain(heading[1]), blocks: [] }; if (sections.length < 14) sections.push(section); lastItem = null; continue; }
    if (!line.trim()) { lastItem = null; continue; }
    if (!section) { section = { heading: "", blocks: [] }; sections.push(section); }
    if (section.blocks.length >= 60) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { lastItem = { kind: "item", text: plain(bullet[1]) }; section.blocks.push(lastItem); }
    else if (lastItem && /^\s+\S/.test(line)) lastItem.text = plain(`${lastItem.text} ${line}`);
    else { lastItem = null; const text = plain(line); if (text) section.blocks.push({ kind: "text", text }); }
  }
  return { title, sections: sections.filter(entry => entry.blocks.length) };
}

interface Listed { tag_name?: unknown; name?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; html_url?: unknown }
let cache: { at: number; releases: ReleaseNotes[] } | null = null;
const parts = (value: string) => { const found = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value); return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null; };
/** The notes of the installed version and of every later release, newest first. Empty, with a reason, when the check is off or cannot be made. */
export async function releaseNotes(force = false): Promise<{ current: string; releases: ReleaseNotes[]; error: string | null }> {
  const base = { current: version, releases: [] as ReleaseNotes[], error: null as string | null };
  if (!runtime().updateCheck) return { ...base, error: "Update checks are turned off, so release notes are not fetched." };
  const repository = process.env.UPDATE_REPOSITORY ?? "Installation-04/StreamRD";
  if (!UPDATE_SLUG.test(repository)) return { ...base, error: "UPDATE_REPOSITORY is not a valid owner/name." };
  if (!force && cache && Date.now() - cache.at < 30 * 60 * 1000) return { ...base, releases: cache.releases };
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=30`, { headers: { Accept: "application/vnd.github+json", "User-Agent": `${PRODUCT.id}-update-check` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(String(response.status));
    const listed = await response.json() as Listed[];
    const releases: ReleaseNotes[] = [];
    for (const entry of Array.isArray(listed) ? listed : []) {
      if (entry.draft === true || entry.prerelease === true || typeof entry.tag_name !== "string" || !parts(entry.tag_name) || typeof entry.body !== "string") continue;
      const found = entry.tag_name.replace(/^v/, ""), parsed = parseReleaseNotes(entry.body);
      if (!parsed.sections.length) continue;
      releases.push({ version: found, title: parsed.title || (typeof entry.name === "string" ? plain(entry.name) : `v${found}`), publishedAt: typeof entry.published_at === "string" ? entry.published_at : null,
        url: typeof entry.html_url === "string" && entry.html_url.startsWith("https://github.com/") ? entry.html_url : null, sections: parsed.sections });
    }
    const wanted = releases.filter(release => release.version === version || isNewer(release.version, version)).sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1)).slice(0, 15);
    cache = { at: Date.now(), releases: wanted };
    return { ...base, releases: wanted };
  } catch { return { ...base, error: "The release notes could not be fetched. Try again later." }; }
}
export function clearReleaseNotesCache(): void { cache = null; }
