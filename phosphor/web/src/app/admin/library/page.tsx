"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { del, get, post } from "@/lib/api";
import styles from "./library.module.css";

type Media = { name: string; year?: number; type: "movie" | "episode"; season?: number; episode?: number; sourcePath: string };
type Entry = { id: string; media: Media; libraryPath: string; sourceAvailable: boolean; linked: boolean };
type LibraryStatus = { enabled: boolean; sourceRoot?: string; exportRoot?: string; entries: Entry[] };
type BrowseItem = { kind: "directory" | "file"; name: string; path: string; sizeBytes?: number; suggested?: Media };
type BrowsePage = { path: string; parentPath: string | null; items: BrowseItem[]; nextCursor: string | null };
type Draft = { sourcePath: string; name: string; year: string; type: "movie" | "episode"; season: string; episode: string };
type BatchResult = { index: number; sourcePath: string; status: "exported" | "error"; entry?: Entry; error?: string };
const MAX_BATCH = 100;

function makeDraft(media: Media): Draft {
  return { sourcePath: media.sourcePath, name: media.name, year: media.year?.toString() ?? "", type: media.type, season: media.season?.toString() ?? "1", episode: media.episode?.toString() ?? "1" };
}
function formatSize(bytes?: number) {
  if (bytes === undefined) return "Video";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function FolderIcon({ file = false }: { file?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {file ? <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h4M10 12l5 3-5 3z" /></> : <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
  </svg>;
}

export default function LibraryPage() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [browse, setBrowse] = useState<BrowsePage | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const browseSequence = useRef(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [healthFilter, setHealthFilter] = useState("all");
  const [visibleExports, setVisibleExports] = useState(40);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [manualName, setManualName] = useState("");
  const [manualPath, setManualPath] = useState("");
  const reviewHeading = useRef<HTMLHeadingElement>(null);

  const loadStatus = useCallback(async () => { setStatus(await get<LibraryStatus>("/api/admin/library")); }, []);
  const loadFolder = useCallback(async (directory: string, cursor?: string) => {
    const sequence = ++browseSequence.current;
    setBrowseLoading(true); setBrowseError("");
    if (!cursor) setBrowse({ path: directory, parentPath: directory ? directory.split("/").slice(0, -1).join("/") : null, items: [], nextCursor: null });
    try {
      const params = new URLSearchParams({ path: directory, limit: "50", ...(cursor ? { cursor } : {}) });
      const page = await get<BrowsePage>(`/api/admin/library/files?${params}`);
      if (sequence !== browseSequence.current) return;
      setBrowse(previous => cursor && previous?.path === page.path
        ? { ...page, items: [...previous.items, ...page.items.filter(item => !previous.items.some(existing => existing.path === item.path))] }
        : page);
    } catch (e) { if (sequence === browseSequence.current) setBrowseError((e as Error).message); }
    finally { if (sequence === browseSequence.current) setBrowseLoading(false); }
  }, []);
  useEffect(() => {
    let current = true;
    void get<LibraryStatus>("/api/admin/library").then(result => { if (current) setStatus(result); }).catch(e => { if (current) setError((e as Error).message); }).finally(() => { if (current) setStatusLoading(false); });
    return () => { current = false; browseSequence.current += 1; };
  }, []);
  useEffect(() => { if (status?.enabled) void loadFolder(""); }, [status?.enabled, loadFolder]);
  useEffect(() => { setVisibleExports(40); }, [query, healthFilter]);

  const readyCount = status?.entries.filter(entry => entry.sourceAvailable && entry.linked).length ?? 0;
  const attentionCount = (status?.entries.length ?? 0) - readyCount;
  const filtered = useMemo(() => (status?.entries ?? []).filter(entry => {
    const healthy = entry.sourceAvailable && entry.linked;
    const matchesHealth = healthFilter === "all" || (healthFilter === "ready" ? healthy : !healthy);
    return matchesHealth && `${entry.media.name} ${entry.media.sourcePath} ${entry.libraryPath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }), [status?.entries, query, healthFilter]);
  const selectedPaths = useMemo(() => new Set(drafts.map(item => item.sourcePath)), [drafts]);
  const breadcrumbs = (browse?.path ?? "").split("/").filter(Boolean);

  function addDraft(media: Media) {
    setError("");
    if (selectedPaths.has(media.sourcePath)) return;
    if (drafts.length >= MAX_BATCH) { setError(`Review up to ${MAX_BATCH} files at a time. Export this selection before adding more.`); return; }
    setDrafts(previous => [...previous, makeDraft(media)]);
  }
  function toggleFile(item: BrowseItem) {
    if (selectedPaths.has(item.path)) setDrafts(previous => previous.filter(draft => draft.sourcePath !== item.path));
    else addDraft(item.suggested ?? { name: item.name.replace(/\.[^.]+$/, ""), sourcePath: item.path, type: "movie" });
  }
  function updateDraft(sourcePath: string, update: Partial<Draft>) {
    setDrafts(previous => previous.map(item => item.sourcePath === sourcePath ? { ...item, ...update } : item));
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); await loadStatus(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function exportBatch() {
    const snapshot = [...drafts];
    const items: Media[] = snapshot.map(item => ({ name: item.name.trim(), sourcePath: item.sourcePath, type: item.type,
      ...(item.year ? { year: Number(item.year) } : {}), ...(item.type === "episode" ? { season: Number(item.season), episode: Number(item.episode) } : {}) }));
    await perform(async () => {
      const response = await post<{ results: BatchResult[]; summary: { exported: number; failed: number } }>("/api/admin/library/entries/batch", { items });
      setBatchResults(response.results);
      const successful = new Set(response.results.filter(result => result.status === "exported").map(result => snapshot[result.index]?.sourcePath));
      setDrafts(previous => previous.filter(item => !successful.has(item.sourcePath)));
      setMessage(`${response.summary.exported} ${response.summary.exported === 1 ? "file exported" : "files exported"}${response.summary.failed ? `; ${response.summary.failed} need attention. Unsuccessful files remain in review.` : ". Your library is ready for a Plex or Jellyfin scan."}`);
    });
  }

  return <div className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Your media, every screen</p><h2>Plex &amp; Jellyfin library</h2><p className={styles.intro}>Choose mounted videos, review their names, and create a library your media server can scan.</p></div>
      <a className={styles.guideLink} href="https://github.com/Installation-04/StreamRD/wiki/Plex-and-Jellyfin" target="_blank" rel="noreferrer">Setup guide <span aria-hidden="true">↗</span></a>
    </header>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {message && <div className={styles.notice} role="status">{message}</div>}
    {statusLoading && <div className={styles.empty} aria-busy="true"><span className={styles.loadingDot} /> Checking your library…</div>}
    {!statusLoading && !status && <div className={styles.empty}><h3>We couldn’t check the library</h3><p>Check the media mount and backend connection, then try again.</p><button className="btn btn-secondary" disabled={busy} onClick={() => void perform(loadStatus)}>Try again</button></div>}
    {status && !status.enabled && <section className={styles.setup}>
      <span className={styles.setupIcon} aria-hidden="true">↗</span><div><p className={styles.eyebrow}>An optional connection</p><h3>Bring your library to Plex or Jellyfin</h3><p>Connect a local media mount, such as rclone or Zurg, to export real video files without copying them. Your usual stream URLs keep working without a mount.</p>
      <ol><li>Mount your media on the server.</li><li>Set <code>MEDIA_SOURCE_ROOT</code> and <code>MEDIA_LIBRARY_ROOT</code> to separate directories.</li><li>Give Plex or Jellyfin the same source mount path and the exported Movies / TV Shows folders.</li></ol>
      <a className="btn" href="https://github.com/Installation-04/StreamRD/wiki/Plex-and-Jellyfin" target="_blank" rel="noreferrer">Connect a media mount</a></div>
    </section>}
    {status?.enabled && <>
      <section className={styles.metrics} aria-label="Library summary">
        <div><span className={styles.metricValue}>{readyCount}</span><span>Ready to scan</span><i className={styles.healthyDot} aria-hidden="true" /></div>
        <div><span className={styles.metricValue}>{attentionCount}</span><span>Need attention</span><i className={attentionCount ? styles.warningDot : styles.neutralDot} aria-hidden="true" /></div>
        <div><span className={styles.metricValue}>{drafts.length}</span><span>In review</span><i className={styles.neutralDot} aria-hidden="true" /></div>
      </section>
      <details className={styles.mountDetails}><summary>Mounts &amp; scanner setup</summary><dl><div><dt>Source mount</dt><dd><code>{status.sourceRoot}</code></dd></div><div><dt>Export library</dt><dd><code>{status.exportRoot}</code></dd></div></dl><p>Add <code>Movies</code> as a movie library and <code>TV Shows</code> as a series library. Plex and Jellyfin must also see each symlink target at the same absolute mount path.</p></details>
      <div className={styles.workspace}>
        <section className={styles.panel} aria-labelledby="browse-heading">
          <div className={styles.panelHeading}><div><span className={styles.step}>01 / Choose</span><h3 id="browse-heading">Browse your media</h3></div><button className={styles.textButton} disabled={busy || browseLoading} onClick={() => void loadFolder(browse?.path ?? "")}>Refresh</button></div>
          <nav className={styles.breadcrumbs} aria-label="Media folder"><button disabled={busy || browseLoading} onClick={() => void loadFolder("")} aria-current={!browse?.path ? "location" : undefined}>Media mount</button>{breadcrumbs.map((part, index) => <span key={breadcrumbs.slice(0, index + 1).join("/")}><span className={styles.separator} aria-hidden="true">/</span><button disabled={busy || browseLoading} aria-current={index === breadcrumbs.length - 1 ? "location" : undefined} onClick={() => void loadFolder(breadcrumbs.slice(0, index + 1).join("/"))}>{part}</button></span>)}</nav>
          {browseError && <div className={styles.browserError} role="alert"><p>{browseError}</p><button className={styles.textButton} disabled={browseLoading} onClick={() => void loadFolder(browse?.path ?? "")}>Try loading this folder again</button></div>}
          <div className={styles.fileList} aria-busy={browseLoading}>
            {browse?.parentPath !== null && browse?.parentPath !== undefined && <button className={styles.folderRow} disabled={busy || browseLoading} onClick={() => void loadFolder(browse.parentPath ?? "")}><span aria-hidden="true">↰</span><span>Parent folder</span></button>}
            {browse?.items.map(item => item.kind === "directory" ? <button key={item.path} className={styles.folderRow} disabled={busy || browseLoading} onClick={() => void loadFolder(item.path)}><FolderIcon /><span>{item.name}</span><span className={styles.rowHint}>Open <span aria-hidden="true">→</span></span></button> : <label key={item.path} className={`${styles.fileRow} ${selectedPaths.has(item.path) ? styles.selectedFile : ""}`}>
              <input type="checkbox" checked={selectedPaths.has(item.path)} disabled={busy || (!selectedPaths.has(item.path) && drafts.length >= MAX_BATCH)} onChange={() => toggleFile(item)} aria-label={`Select ${item.name}`} /><FolderIcon file /><span className={styles.fileName}>{item.name}<small>{item.suggested?.type === "episode" ? `Episode · S${String(item.suggested.season).padStart(2, "0")}E${String(item.suggested.episode).padStart(2, "0")}` : "Movie suggestion"}</small></span><span className={styles.fileSize}>{formatSize(item.sizeBytes)}</span>
            </label>)}
            {browseLoading && <p className={styles.browserMessage} role="status">Loading mounted files…</p>}
            {!browseLoading && !browseError && browse?.items.length === 0 && <div className={styles.browserEmpty}><FolderIcon /><h4>No videos in this folder yet</h4><p>Only folders and supported video files appear here. Check your mount or choose another folder.</p></div>}
          </div>
          {browse?.nextCursor && <button className={styles.loadMore} disabled={busy || browseLoading} onClick={() => void loadFolder(browse.path, browse.nextCursor ?? undefined)}>{browseLoading ? "Loading…" : "Load more files"}</button>}
          <div className={styles.browserFooter}><span>{drafts.length} / {MAX_BATCH} files selected</span><button className={styles.textButton} disabled={!drafts.length} onClick={() => { reviewHeading.current?.focus(); reviewHeading.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }}>Review selection <span aria-hidden="true">→</span></button></div>
          <details className={styles.manual}>
            <summary>Already know the file path?</summary><form onSubmit={event => { event.preventDefault(); addDraft({ name: manualName.trim(), sourcePath: manualPath.trim(), type: "movie" }); setManualName(""); setManualPath(""); }}>
              <label>Movie or series name<input required maxLength={160} value={manualName} disabled={busy} onChange={event => setManualName(event.target.value)} placeholder="Example (2024)" /></label>
              <label>Path relative to your mount<input required value={manualPath} disabled={busy} onChange={event => setManualPath(event.target.value)} placeholder="movies/Example/movie.mkv" /></label>
              <button className="btn btn-secondary" disabled={busy || drafts.length >= MAX_BATCH}>Add to review</button>
            </form>
          </details>
        </section>
        <section className={styles.panel} aria-labelledby="review-heading">
          <div className={styles.panelHeading}><div><span className={styles.step}>02 / Review</span><h3 id="review-heading" ref={reviewHeading} tabIndex={-1}>Make it scanner-ready</h3></div>{drafts.length > 0 && <button className={styles.textButton} disabled={busy} onClick={() => setDrafts([])}>Clear</button>}</div>
          <p className={styles.reviewHint}>Names and episode numbers are filename suggestions. Check them before exporting.</p>
          <form onSubmit={event => { event.preventDefault(); void exportBatch(); }}>
            {drafts.length === 0 && <div className={styles.reviewEmpty}><span className={styles.reviewSymbol} aria-hidden="true">✓</span><h4>Your next library starts here</h4><p>Select a video on the left to review its title and scanner details. No files are exported until you choose Export.</p></div>}
            <div className={styles.draftList}>{drafts.map((draft, index) => <fieldset className={styles.draft} key={draft.sourcePath} disabled={busy}>
              <legend className={styles.srOnly}>{`Review ${draft.name || `file ${index + 1}`}`}</legend>
              <div className={styles.draftTop}><span className={styles.fileNumber}>{String(index + 1).padStart(2, "0")}</span><code title={draft.sourcePath}>{draft.sourcePath}</code><button type="button" className={styles.removeDraft} aria-label={`Remove ${draft.name || draft.sourcePath} from review`} onClick={() => setDrafts(previous => previous.filter(item => item.sourcePath !== draft.sourcePath))}>×</button></div>
              <label>Movie or series name<input required maxLength={160} value={draft.name} onChange={event => updateDraft(draft.sourcePath, { name: event.target.value })} /></label>
              <div className={styles.fields}><label>Type<select value={draft.type} onChange={event => updateDraft(draft.sourcePath, { type: event.target.value as Draft["type"] })}><option value="movie">Movie</option><option value="episode">TV episode</option></select></label><label>Year <span className={styles.optional}>(optional)</span><input type="number" min={1800} max={2200} value={draft.year} onChange={event => updateDraft(draft.sourcePath, { year: event.target.value })} /></label></div>
              {draft.type === "episode" && <div className={styles.fields}><label>Season<input type="number" required min={0} max={999} value={draft.season} onChange={event => updateDraft(draft.sourcePath, { season: event.target.value })} /></label><label>Episode<input type="number" required min={1} max={9999} value={draft.episode} onChange={event => updateDraft(draft.sourcePath, { episode: event.target.value })} /></label></div>}
            </fieldset>)}</div>
            <div className={styles.exportFooter}><p>Creates symlinks. Original media stays in place.</p><button className="btn" disabled={busy || drafts.length === 0}>{busy ? "Working…" : `Export ${drafts.length || "selected"} ${drafts.length === 1 ? "file" : "files"}`} <span aria-hidden="true">↗</span></button></div>
          </form>
          {batchResults.length > 0 && <div className={styles.batchResults} aria-label="Last export results"><h4>Last export</h4><ul>{batchResults.map(result => <li key={`${result.index}-${result.sourcePath}`} className={result.status === "error" ? styles.resultError : styles.resultSuccess}><span aria-hidden="true">{result.status === "exported" ? "✓" : "!"}</span><div><strong>{result.entry?.media.name || result.sourcePath || `File ${result.index + 1}`}</strong><p>{result.status === "exported" ? "Exported successfully" : result.error || "This file could not be exported. Review its details and try again."}</p></div></li>)}</ul></div>}
        </section>
      </div>
      <section className={styles.exports} aria-labelledby="exports-heading">
        <div className={styles.exportHeading}><div><span className={styles.step}>03 / Scan</span><h3 id="exports-heading">Your exported library <span className={styles.count}>{status.entries.length}</span></h3><p>Run a library scan in Plex or Jellyfin after exporting. Scans stay under your control.</p></div><div className={styles.actions}><button className="btn btn-secondary" disabled={busy} onClick={() => void perform(async () => {
          const result = await post<{ results: { status: string }[] }>("/api/admin/library/repair");
          setMessage(`Checked ${result.results.length} exports: ${result.results.filter(item => item.status === "repaired").length} repaired, ${result.results.filter(item => item.status === "unavailable" || item.status === "conflict").length} need attention.`);
        })}>Check &amp; repair links</button><button className={styles.textButton} disabled={busy} onClick={() => void perform(async () => {})}>Refresh status</button></div></div>
        <div className={styles.exportFilters}><label className={styles.searchLabel}><span className={styles.srOnly}>Search exported files</span><input type="search" placeholder="Search titles or file paths…" value={query} onChange={event => setQuery(event.target.value)} /></label><label className={styles.filterLabel}><span className={styles.srOnly}>Export health</span><select value={healthFilter} onChange={event => setHealthFilter(event.target.value)}><option value="all">All statuses</option><option value="ready">Ready to scan</option><option value="attention">Needs attention</option></select></label></div>
        {status.entries.length === 0 ? <div className={styles.exportEmpty}><h4>No exports yet</h4><p>Your reviewed movie and episode links will appear here.</p></div> : filtered.length === 0 ? <div className={styles.exportEmpty}><h4>No matching exports</h4><p>Try another search or status filter.</p></div> : <div className={styles.exportList}>{filtered.slice(0, visibleExports).map(entry => <article className={styles.exportRow} key={entry.id}>
          <div className={styles.exportMediaIcon}><FolderIcon file /></div><div className={styles.exportInfo}><div className={styles.exportTitle}><h4>{entry.media.name}</h4><span className={entry.sourceAvailable && entry.linked ? styles.readyBadge : styles.attentionBadge}>{!entry.sourceAvailable ? "Source unavailable" : entry.linked ? "Ready to scan" : "Check link"}</span></div><code>{entry.libraryPath}</code><p>Source: {entry.media.sourcePath}</p>
          {removingId === entry.id && <div className={styles.removeConfirmation}><p>Remove this export? The source video will stay in your mount.</p><div><button className={styles.dangerButton} disabled={busy} onClick={() => void perform(async () => { await del(`/api/admin/library/entries/${entry.id}`); setRemovingId(null); setMessage("Export removed. Source media was kept."); })}>Remove export</button><button className={styles.textButton} disabled={busy} onClick={() => setRemovingId(null)}>Keep it</button></div></div>}</div>
          {removingId !== entry.id && <button className={styles.textButton} disabled={busy} aria-label={`Remove export for ${entry.media.name}`} onClick={() => setRemovingId(entry.id)}>Remove link</button>}
        </article>)}</div>}
        {filtered.length > visibleExports && <button className={styles.loadMore} onClick={() => setVisibleExports(value => value + 40)}>Show more exports ({filtered.length - visibleExports} remaining)</button>}
      </section>
    </>}
  </div>;
}
