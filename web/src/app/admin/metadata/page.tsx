"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import MetadataPicker from "@/components/MetadataPicker";
import { imdbLink, METADATA_FIELDS, METADATA_LABELS, MetadataProvider, MetadataRecord, MetadataSettings, MetadataSummary, PROVIDER_LABELS } from "@/lib/metadata";
import styles from "./metadata.module.css";

const INITIAL_SUMMARY: MetadataSummary = { queued: 0, processing: 0, matched: 0, review: 0, unmatched: 0, error: 0 };
const STATES: Record<MetadataRecord["status"], string> = { queued: "Queued", processing: "Matching", matched: "Matched", review: "Review match", unmatched: "No confident match", error: "Retry needed" };
function messageFor(reason: unknown, fallback: string) { return reason instanceof ApiError ? reason.message : fallback; }
function recordPath(record: MetadataRecord) { return `/api/admin/metadata/records/${record.targetType}/${encodeURIComponent(record.targetId)}`; }

export default function MetadataPage() {
  const [settings, setSettings] = useState<MetadataSettings | null>(null);
  const [saved, setSaved] = useState<MetadataSettings | null>(null);
  const [tmdbKey, setTmdbKey] = useState("");
  const [omdbKey, setOmdbKey] = useState("");
  const [clearTmdb, setClearTmdb] = useState(false);
  const [clearOmdb, setClearOmdb] = useState(false);
  const [records, setRecords] = useState<MetadataRecord[]>([]);
  const [summary, setSummary] = useState<MetadataSummary>(INITIAL_SUMMARY);
  const [historyCheckedAt, setHistoryCheckedAt] = useState<string | null>(null);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [picker, setPicker] = useState<MetadataRecord | null>(null);
  const [locksFor, setLocksFor] = useState<MetadataRecord | null>(null);
  const [lockedFields, setLockedFields] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tested, setTested] = useState<Partial<Record<MetadataProvider, string>>>({});
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const controllers = useRef(new Set<AbortController>());
  const scanCancel = useRef(false);
  const scanController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const recordsGeneration = useRef(0);
  const reading = useRef(false);
  const actionBusy = useRef(false);

  const request = useCallback(async <T,>(path: string, method = "GET", body?: unknown) => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { return await api<T>(path, { method, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    finally { controllers.current.delete(controller); }
  }, []);
  const loadRecords = useCallback(async (cursor?: string, background = false) => {
    if (background && reading.current) return;
    const generation = ++recordsGeneration.current; reading.current = true;
    try {
      const result = await request<{ records: MetadataRecord[]; nextCursor: string | null; summary: MetadataSummary }>(`/api/admin/metadata/records?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!mounted.current || generation !== recordsGeneration.current) return;
      setRecords(existing => {
        const combined = cursor ? [...existing, ...result.records.filter(record => !existing.some(item => item.id === record.id))] : result.records;
        return combined.slice(-200);
      });
      if (cursor) setHasLoadedMore(true); else setHasLoadedMore(false);
      setNextCursor(result.nextCursor); setSummary(result.summary); setHistoryCheckedAt(new Date().toLocaleTimeString());
    } catch (reason) {
      if (mounted.current && generation === recordsGeneration.current && !background) throw reason;
    } finally { if (generation === recordsGeneration.current) reading.current = false; }
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([request<{ settings: MetadataSettings }>("/api/admin/metadata/settings"), loadRecords()])
      .then(([response]) => { if (mounted.current) { setSettings(response.settings); setSaved(response.settings); } })
      .catch(reason => { if (mounted.current) setError(messageFor(reason, "Metadata settings could not be loaded. Check the backend and try again.")); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; scanCancel.current = true; scanController.current?.abort(); controllers.current.forEach(controller => controller.abort()); recordsGeneration.current++; };
  }, [request, loadRecords]);
  // A bounded visible-only queue refresh. Provider calls are performed by the server.
  useEffect(() => {
    if (summary.queued + summary.processing === 0 || nextCursor) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !actionBusy.current && !scanning) void loadRecords(undefined, true); }, 5000);
    return () => clearInterval(timer);
  }, [summary.queued, summary.processing, nextCursor, scanning, loadRecords]);

  async function perform(label: string, run: () => Promise<void>) {
    if (actionBusy.current) return;
    actionBusy.current = true; setBusy(label); setError(""); setNotice("");
    try { await run(); }
    catch (reason) { if (mounted.current) setError(messageFor(reason, "The metadata operation could not finish. Try again.")); }
    finally { actionBusy.current = false; if (mounted.current) setBusy(""); }
  }
  function changeSetting(patch: Partial<MetadataSettings>) { setSettings(current => current ? { ...current, ...patch } : current); setTested({}); }
  const dirty = Boolean(settings && saved && (settings.provider !== saved.provider || settings.language !== saved.language || settings.automatic !== saved.automatic || settings.refreshDays !== saved.refreshDays || tmdbKey || omdbKey || clearTmdb || clearOmdb));
  function saveSettings(event: React.FormEvent) {
    event.preventDefault(); if (!settings) return;
    void perform("Saving settings…", async () => {
      const result = await request<{ settings: MetadataSettings }>("/api/admin/metadata/settings", "PUT", {
        provider: settings.provider, language: settings.language, automatic: settings.automatic, refreshDays: settings.refreshDays,
        ...(tmdbKey.trim() ? { tmdbApiKey: tmdbKey.trim() } : {}), ...(omdbKey.trim() ? { omdbApiKey: omdbKey.trim() } : {}), clearTmdb, clearOmdb,
      });
      if (!mounted.current) return;
      setSettings(result.settings); setSaved(result.settings); setTmdbKey(""); setOmdbKey(""); setClearTmdb(false); setClearOmdb(false); setTested({}); setNotice("Settings saved. Provider keys remain on the server. Saving does not test the connection.");
      await loadRecords();
    });
  }
  function test(provider: MetadataProvider) {
    void perform(`Testing ${PROVIDER_LABELS[provider]}…`, async () => {
      await request("/api/admin/metadata/test", "POST", { provider });
      if (mounted.current) setTested(current => ({ ...current, [provider]: new Date().toLocaleTimeString() }));
      setNotice(`${PROVIDER_LABELS[provider]} responded successfully to an explicit connection test.`);
    });
  }
  async function scan(targetType: "library") {
    if (scanning || actionBusy.current) return;
    scanCancel.current = false; setScanning(true); setScanProgress(0); setError(""); setNotice("");
    let cursor: string | undefined, queued = 0;
    const seen = new Set<string>();
    try {
      do {
        const controller = new AbortController(); scanController.current = controller;
        const result = await api<{ queued: number; nextCursor: string | null }>("/api/admin/metadata/scan", { method: "POST", signal: controller.signal, body: JSON.stringify({ targetType, limit: 100, ...(cursor ? { cursor } : {}) }) });
        if (!mounted.current || scanCancel.current) break;
        queued += result.queued; setScanProgress(queued);
        cursor = result.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("Repeated scan cursor");
        if (cursor) seen.add(cursor);
        await loadRecords();
      } while (cursor && !scanCancel.current);
      if (mounted.current) setNotice(`${scanCancel.current ? "Scan stopped." : "Scan complete."} ${queued} ${queued === 1 ? "item" : "items"} queued for metadata lookup. Matching continues on the server.`);
    } catch (reason) { if (mounted.current) { if (scanCancel.current) setNotice(`Scan stopped. Items already queued will continue matching on the server.`); else setError(messageFor(reason, "The scan could not finish. Already queued items are retained; you can safely scan again.")); } }
    finally { scanController.current = null; if (mounted.current) setScanning(false); }
  }
  function stopScan() { scanCancel.current = true; scanController.current?.abort(); }
  function refreshRecord(record: MetadataRecord) {
    void perform("Queueing refresh…", async () => { await request(recordPath(record) + "/refresh", "POST", {}); await loadRecords(); setNotice(`Refresh queued for ${record.name}. Locked fields are preserved.`); });
  }
  function saveLocks() {
    if (!locksFor) return;
    void perform("Saving field locks…", async () => { await request(recordPath(locksFor) + "/locks", "PATCH", { lockedFields, expectedRevision: locksFor.revision }); setLocksFor(null); await loadRecords(); setNotice("Field locks saved. Locked values are protected during metadata refresh."); });
  }
  const visibleRecords = records.filter(record => filter === "all" || (filter === "attention" ? ["review", "unmatched", "error"].includes(record.status) : filter === "pending" ? ["queued", "processing"].includes(record.status) : record.status === filter));
  const pending = summary.queued + summary.processing;
  const attention = summary.review + summary.unmatched + summary.error;
  const configured = Boolean(settings); // the built-in source needs no key, so a source is always available once settings load
  return <div className={styles.page}>
    <header className={styles.header}><div><p className={styles.eyebrow}>YOUR COLLECTION / AUTOMATICALLY ENRICHED</p><h2>Make every title feel complete.</h2><p className={styles.intro}>Posters, stories, cast, and the right match. Connect a metadata provider, automate confident matches, and keep the final say.</p></div><div className={`${styles.connection} ${configured ? styles.configured : ""}`}><span /><div><strong>{configured ? "Source ready" : "Loading…"}</strong><small>{settings ? PROVIDER_LABELS[settings.activeProvider] : "Built-in · TMDB · OMDb / IMDb"}</small></div></div></header>
    <section className={styles.metrics} aria-label="Metadata summary"><div><span>Enriched titles</span><strong>{historyCheckedAt ? summary.matched : "—"}</strong><small>Matched metadata records</small></div><div><span>In the queue</span><strong>{historyCheckedAt ? pending : "—"}</strong><small>{historyCheckedAt ? `${summary.processing} currently matching` : "Waiting for activity"}</small></div><div><span>Need your eye</span><strong>{historyCheckedAt ? attention : "—"}</strong><small>Review uncertain or failed matches</small></div><div><span>Automation</span><strong className={styles.automationValue}>{saved ? saved.automatic ? "On" : "Off" : "—"}</strong><small>{saved ? saved.automatic ? `Refresh every ${saved.refreshDays} days` : "Manual matching is always available" : "Waiting for provider settings"}</small></div></section>
    {error && <div className={styles.error} role="alert"><strong>Metadata needs attention</strong><p>{error}</p>{!settings && <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>Try again</button>}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {loading && <p className={styles.loading} role="status">Loading provider settings and matching history…</p>}
    {settings && <div className={styles.workspace}>
      <form className={styles.panel} onSubmit={saveSettings}>
        <div className={styles.panelHeading}><div><p className={styles.eyebrow}>01 / CONNECT</p><h3>Metadata providers</h3></div><span className={styles.serverBadge}>Server only</span></div>
        <p className={styles.copy}>Metadata works right away with the built-in source, which needs no account or API key. For richer artwork and details, add your own TMDB or OMDb key below; keys are never returned to the browser.</p>
        <div className={styles.providerCard}><div className={styles.providerHeading}><strong>Built-in (no account needed)</strong><span>Always available</span></div><p>Titles, posters, ratings, genres and cast from Cinemeta, which serves IMDb-linked data. Titles you match are sent to that service. Used automatically whenever the chosen provider has no key.</p>
          <div className={styles.providerStatus}><span>{tested.free ? `Test passed at ${tested.free}` : "No setup required · Not tested in this session"}</span><button type="button" disabled={Boolean(busy)} onClick={() => test("free")}>Test connection</button></div>
        </div>
        <div className={styles.providerCard}><div className={styles.providerHeading}><strong>TMDB</strong><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Get an API key ↗</a></div><p>Posters, backdrops, genres, cast, and external IMDb IDs.</p>
          <label htmlFor="metadata-tmdb-key">TMDB API key or read access token<input id="metadata-tmdb-key" type="password" autoComplete="new-password" value={tmdbKey} maxLength={512} disabled={Boolean(busy) || clearTmdb} placeholder={settings.tmdbConfigured ? "Saved key · leave blank to keep" : "Paste your API key or read access token"} onChange={event => { setTmdbKey(event.target.value); setTested({}); }} /></label>
          <div className={styles.providerStatus}><span>{settings.tmdbConfigured ? "Key saved" : settings.projectTmdbKey ? "Using this server’s shared TMDB key" : "No saved key"}{tested.tmdb ? ` · Test passed at ${tested.tmdb}` : " · Not tested in this session"}</span><button type="button" disabled={Boolean(busy) || dirty || !(settings.tmdbConfigured || settings.projectTmdbKey)} onClick={() => test("tmdb")}>Test connection</button></div>
          {settings.tmdbConfigured && <label className={styles.checkbox}><input type="checkbox" checked={clearTmdb} disabled={Boolean(busy)} onChange={event => { setClearTmdb(event.target.checked); if (event.target.checked) setTmdbKey(""); setTested({}); }} />Remove the saved TMDB key when I save</label>}
        </div>
        <div className={styles.providerCard}><div className={styles.providerHeading}><strong>OMDb / IMDb</strong><a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer">Get an API key ↗</a></div><p>Find titles by IMDb ID and bring in IMDb ratings, cast, and plot.</p>
          <label htmlFor="metadata-omdb-key">OMDb API key<input id="metadata-omdb-key" type="password" autoComplete="new-password" value={omdbKey} maxLength={512} disabled={Boolean(busy) || clearOmdb} placeholder={settings.omdbConfigured ? "Saved key · leave blank to keep" : "Paste your OMDb API key"} onChange={event => { setOmdbKey(event.target.value); setTested({}); }} /></label>
          <div className={styles.providerStatus}><span>{settings.omdbConfigured ? "Key saved" : "No saved key"}{tested.omdb ? ` · Test passed at ${tested.omdb}` : " · Not tested in this session"}</span><button type="button" disabled={Boolean(busy) || dirty || !settings.omdbConfigured} onClick={() => test("omdb")}>Test connection</button></div>
          {settings.omdbConfigured && <label className={styles.checkbox}><input type="checkbox" checked={clearOmdb} disabled={Boolean(busy)} onChange={event => { setClearOmdb(event.target.checked); if (event.target.checked) setOmdbKey(""); setTested({}); }} />Remove the saved OMDb key when I save</label>}
        </div>
        <div className={styles.formGrid}><label htmlFor="metadata-provider">Default provider<select id="metadata-provider" value={settings.provider} disabled={Boolean(busy)} onChange={event => changeSetting({ provider: event.target.value as MetadataProvider })}><option value="free">Built-in (no account)</option><option value="tmdb">TMDB</option><option value="omdb">OMDb / IMDb</option></select>{settings.activeProvider !== settings.provider && <small role="note">No saved key for {PROVIDER_LABELS[settings.provider]}, so the built-in source is used.</small>}</label><label htmlFor="metadata-language">TMDB language<input id="metadata-language" value={settings.language} required pattern="[a-z]{2}-[A-Z]{2}" placeholder="en-US" maxLength={5} disabled={Boolean(busy)} onChange={event => changeSetting({ language: event.target.value })} /></label></div>
        <div className={styles.automation}><div className={styles.automationHeading}><div><strong>Match automatically</strong><p>Confident matches are enriched in the background. Uncertain titles stay in review.</p></div><label className={styles.switch}><span className={styles.srOnly}>Enable automatic metadata matching</span><input type="checkbox" checked={settings.automatic} disabled={Boolean(busy)} onChange={event => changeSetting({ automatic: event.target.checked })} /><span aria-hidden="true" /></label></div>
          <label htmlFor="metadata-refresh-days">Refresh matched metadata every <span className={styles.daysInput}><input id="metadata-refresh-days" type="number" min={1} max={90} required value={settings.refreshDays} disabled={Boolean(busy)} onChange={event => changeSetting({ refreshDays: Number(event.target.value) })} /> days</span></label>
        </div>
        <div className={styles.saveRow}><button type="submit" className="btn" disabled={Boolean(busy) || !dirty}>{busy === "Saving settings…" ? busy : "Save metadata settings"}</button><span>{dirty ? "Unsaved changes · save before testing" : "Settings saved locally"}</span></div>
      </form>
      <aside className={styles.guidePanel}>
        <p className={styles.eyebrow}>02 / AUTOMATE WITH CONFIDENCE</p><h3>A richer library.<br />Your choices stay yours.</h3>
        <ol><li><span>01</span><div><strong>Connect once</strong><p>Keep credentials on your server. Test a saved provider when you are ready.</p></div></li><li><span>02</span><div><strong>Let clear matches through</strong><p>Automation is opt-in. Ambiguous names and years need your review.</p></div></li><li><span>03</span><div><strong>Protect the details you love</strong><p>Manual edits and locked fields survive refreshes. Choose a different match at any time.</p></div></li></ol>
        <div className={styles.scanPanel}><h4>Enrich existing media</h4><p>Queue existing items in batches of up to 100. Matching runs on the server, and stopping a scan keeps work already queued.</p><div className={styles.scanButtons}><button type="button" className="btn btn-secondary" disabled={scanning || Boolean(busy) || !configured || dirty} onClick={() => void scan("library")}>Scan mounted library</button></div>{scanning && <div className={styles.scanProgress} role="status"><span>{scanProgress} items queued…</span><button type="button" onClick={stopScan}>Stop scan</button></div>}</div>
        <p className={styles.footnote}>Metadata services receive title searches and identifiers when you look up or automate a match. Existing exports and original media are never renamed automatically.</p>
      </aside>
    </div>}
    <section className={styles.history} aria-labelledby="matching-history-heading">
      <div className={styles.historyHeading}><div><p className={styles.eyebrow}>03 / REVIEW &amp; REFINE</p><h3 id="matching-history-heading">Matching activity</h3><p>See what matched, resolve uncertain titles, and protect individual fields.{historyCheckedAt ? ` Last loaded at ${historyCheckedAt}.` : ""}</p></div><button type="button" className="btn btn-secondary" disabled={Boolean(busy) || scanning} onClick={() => void perform("Refreshing activity…", async () => { await loadRecords(); })}>Refresh activity</button></div>
      <div className={styles.filters} role="group" aria-label="Filter matching activity">{[["all", "All items"], ["attention", "Needs attention"], ["pending", "In progress"], ["matched", "Matched"]].map(([value, label]) => <button type="button" key={value} className={filter === value ? styles.activeFilter : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      {picker && <div className={styles.pickerWrap}><MetadataPicker key={picker.id} query={picker.name} type={picker.mediaType} year={picker.year ?? undefined} target={{ type: picker.targetType, id: picker.targetId }} onClose={() => setPicker(null)} onApplied={() => { setPicker(null); void perform("Refreshing activity…", async () => { await loadRecords(); }); }} /></div>}
      {locksFor && <section className={styles.lockPanel} aria-label={`Field locks for ${locksFor.name}`}><h4>Keep your edits to {locksFor.name}</h4><p>Checked fields are protected from provider updates. Unlock a field to let future matches and refreshes update it.</p><div className={styles.lockFields}>{METADATA_FIELDS.map(field => <label key={field}><input type="checkbox" checked={lockedFields.includes(field)} disabled={Boolean(busy)} onChange={event => setLockedFields(current => event.target.checked ? [...current, field] : current.filter(value => value !== field))} />{METADATA_LABELS[field]}</label>)}</div><div className={styles.scanButtons}><button type="button" className="btn" disabled={Boolean(busy)} onClick={saveLocks}>Save field locks</button><button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => setLocksFor(null)}>Cancel</button></div></section>}
      {!loading && historyCheckedAt && visibleRecords.length === 0 && <div className={styles.empty}><span aria-hidden="true">✧</span><h4>{filter === "all" ? "Your matching story starts here." : "Nothing in this view."}</h4><p>{filter === "all" ? "Connect a provider and scan existing media, or find a match from a title or mounted-library entry." : "Try another filter or refresh matching activity."}</p></div>}
      <div className={styles.records}>{visibleRecords.map(record => {
        const imdb = imdbLink(record.data?.imdbId);
        return <article key={record.id} className={styles.record} aria-label={`Metadata for ${record.name}`}>
          <div className={styles.recordArt}>{record.data?.posterUrl ? <img src={record.data.posterUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = "hidden"; }} /> : <span aria-hidden="true">◇</span>}</div>
          <div className={styles.recordContent}><div className={styles.recordTop}><h4>{record.name}</h4><span className={`${styles.state} ${styles[record.status]}`}>{STATES[record.status]}</span></div><p className={styles.recordMeta}>{record.year ?? "Year unknown"} · {record.mediaType === "series" ? "Series" : "Movie"} · {record.targetType === "catalog" ? "Web catalog" : "Mounted library"}{record.data ? ` · ${PROVIDER_LABELS[record.data.provider]}` : ""}</p>{record.error && <p className={styles.recordError}>{record.error}</p>}{record.status === "review" && !record.error && <p className={styles.recordNote}>Automatic matching was not confident enough. Choose the correct title below.</p>}{record.data?.description && <p className={styles.recordOverview}>{record.data.description}</p>}<div className={styles.recordLinks}>{record.lockedFields.length > 0 && <span>⌑ {record.lockedFields.length} protected {record.lockedFields.length === 1 ? "field" : "fields"}</span>}{imdb && <a href={imdb} target="_blank" rel="noreferrer">IMDb ↗</a>}</div></div>
          <div className={styles.recordActions}><button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} aria-label={`${record.status === "matched" ? "Fix metadata match" : "Find metadata"} for ${record.name}`} onClick={() => { setPicker(record); setLocksFor(null); }}>{record.status === "matched" ? "Fix match" : "Find match"}</button><button type="button" disabled={Boolean(busy) || record.status === "processing"} aria-label={`Refresh metadata for ${record.name}`} onClick={() => refreshRecord(record)}>Refresh metadata</button><button type="button" disabled={Boolean(busy)} aria-label={`Field locks for ${record.name}`} onClick={() => { setLocksFor(record); setLockedFields(record.lockedFields); setPicker(null); }}>Field locks</button></div>
        </article>;
      })}</div>
      {(nextCursor || hasLoadedMore) && <div className={styles.loadMore}><p>Filters apply to the loaded items.{hasLoadedMore ? " This view keeps at most 200 items; Refresh activity returns to the first page." : " Load more to review the rest."}</p>{nextCursor && <button type="button" className="btn btn-secondary" disabled={Boolean(busy) || scanning} onClick={() => void perform("Loading more…", async () => { await loadRecords(nextCursor); })}>Load more activity</button>}</div>}
    </section>
    <footer className={styles.attribution}><img src="/metadata/tmdb.svg" alt="TMDB" width={94} height={24} /><div><p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p><p>Metadata and artwork belong to their respective providers and rights holders. OMDb supplies IMDb-linked data; IMDb does not endorse this app.</p></div></footer>
  </div>;
}
