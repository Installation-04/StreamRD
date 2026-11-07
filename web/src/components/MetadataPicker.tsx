"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { imdbLink, MetadataCandidate, MetadataDetails, MetadataProvider, MetadataRecord, MetadataTarget, MetadataType, PROVIDER_LABELS } from "@/lib/metadata";
import styles from "./MetadataPicker.module.css";

export interface MetadataPickerProps {
  query: string;
  type: MetadataType;
  year?: number;
  target?: MetadataTarget;
  onSelect?: (details: MetadataDetails) => void;
  onApplied?: () => void;
  onClose?: () => void;
}
export default function MetadataPicker({ query, type, year, target, onSelect, onApplied, onClose }: MetadataPickerProps) {
  const id = useId();
  const [term, setTerm] = useState(query);
  const [mediaType, setMediaType] = useState(type);
  const [releaseYear, setReleaseYear] = useState(year?.toString() ?? "");
  const [provider, setProvider] = useState<MetadataProvider | "">("");
  const [results, setResults] = useState<MetadataCandidate[] | null>(null);
  const [preview, setPreview] = useState<MetadataDetails | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState<number | undefined>();
  const recordPath = target?.type === "account" ? `/api/account/library/${encodeURIComponent(target.id)}/metadata` : target ? `/api/admin/metadata/records/${target.type}/${encodeURIComponent(target.id)}` : "";
  const lookupPath = target?.type === "account" ? recordPath : "/api/admin/metadata";
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    controller.current?.abort(); epoch.current++;
    setTerm(query); setMediaType(type); setReleaseYear(year?.toString() ?? "");
    setResults(null); setPreview(null); setBusy(""); setError(""); setMessage(""); setRevision(undefined);
    const local = new AbortController();
    if (target) void api<{ record: MetadataRecord | null }>(recordPath, { signal: local.signal })
      .then(response => { if (!local.signal.aborted) setRevision(response.record?.revision); }).catch(() => {});
    return () => { local.abort(); controller.current?.abort(); epoch.current++; };
  }, [query, type, year, target?.type, target?.id]);
  function change(run: () => void) {
    controller.current?.abort(); epoch.current++; setBusy(""); setPreview(null); setResults(null); setError(""); setMessage(""); run();
  }
  async function perform<T>(label: string, path: string, body: unknown, done: (value: T) => void) {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    const generation = ++epoch.current; setBusy(label); setError(""); setMessage("");
    try {
      const response = await api<T>(path, { method: "POST", signal: active.signal, body: JSON.stringify(body) });
      if (!active.signal.aborted && generation === epoch.current) done(response);
    } catch (reason) {
      if (!active.signal.aborted && generation === epoch.current) setError(reason instanceof ApiError ? reason.message : "Metadata could not be loaded. Check the connection and try again.");
    } finally { if (!active.signal.aborted && generation === epoch.current) setBusy(""); }
  }
  function search() {
    if (!term.trim()) { setError("Enter a title or IMDb ID to search."); return; }
    if (releaseYear && (!/^\d{4}$/.test(releaseYear) || Number(releaseYear) < 1800 || Number(releaseYear) > 2200)) { setError("Enter a year between 1800 and 2200, or leave it empty."); return; }
    setPreview(null); setResults(null);
    void perform<{ results: MetadataCandidate[] }>("Searching…", `${lookupPath}/search`, { query: term.trim(), type: mediaType, ...(releaseYear ? { year: Number(releaseYear) } : {}), ...(provider ? { provider } : {}) }, response => setResults(response.results));
  }
  function inspect(candidate: MetadataCandidate) {
    setPreview(null);
    void perform<{ metadata: MetadataDetails }>("Loading preview…", `${lookupPath}/preview`, { provider: candidate.provider, id: candidate.id, type: candidate.type }, response => setPreview(response.metadata));
  }
  function apply() {
    if (!preview) return;
    if (!target) { onSelect?.(preview); setMessage("Metadata added to the draft. Review the fields before saving."); return; }
    void perform<{ record: MetadataRecord }>("Applying match…", `${recordPath}/match`, { provider: preview.provider, id: preview.id, type: preview.type, ...(revision !== undefined ? { expectedRevision: revision } : {}) }, response => {
      setRevision(response.record.revision); setMessage("Match applied. Locked fields are preserved."); onApplied?.();
    });
  }
  const imdb = imdbLink(preview?.imdbId);
  return <section className={styles.picker} aria-labelledby={`${id}-heading`}>
    <header className={styles.header}><div><span className={styles.eyebrow}>IDENTIFY YOUR MEDIA</span><h3 id={`${id}-heading`}>Find the right match</h3><p>Search a title or IMDb ID, inspect the details, then choose your match.</p></div>{onClose && <button type="button" className={styles.close} onClick={onClose} aria-label="Close metadata matching">✕</button>}</header>
    <div className={styles.searchFields}>
      <label className={styles.titleField} htmlFor={`${id}-query`}>Title or IMDb ID<input id={`${id}-query`} value={term} maxLength={200} onChange={event => change(() => setTerm(event.target.value))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); search(); } }} /></label>
      <label htmlFor={`${id}-type`}>Media type<select id={`${id}-type`} value={mediaType} onChange={event => change(() => setMediaType(event.target.value as MetadataType))}><option value="movie">Movie</option><option value="series">Series</option></select></label>
      <label htmlFor={`${id}-year`}>Year <span>(optional)</span><input id={`${id}-year`} inputMode="numeric" maxLength={4} value={releaseYear} onChange={event => change(() => setReleaseYear(event.target.value))} /></label>
      <label htmlFor={`${id}-provider`}>Provider<select id={`${id}-provider`} value={provider} onChange={event => change(() => setProvider(event.target.value as MetadataProvider | ""))}><option value="">Server default</option><option value="tmdb">TMDB</option><option value="omdb">OMDb / IMDb</option></select></label>
    </div>
    <div className={styles.actions}><button type="button" className="btn" disabled={Boolean(busy)} onClick={search}>Search metadata</button>{target?.type === "account" ? <span>Metadata providers are managed by your administrator.</span> : <Link href="/admin/metadata">Provider settings ↗</Link>}{busy && <span role="status">{busy}</span>}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}{message && <p className={styles.success} role="status">{message}</p>}
    {results && results.length === 0 && <div className={styles.empty}><h4>No matches found</h4><p>Try the original title, a different year, an IMDb ID, or another configured provider.</p></div>}
    {results && results.length > 0 && <div className={styles.results} aria-label="Metadata search results">{results.map(candidate => <button type="button" key={`${candidate.provider}-${candidate.type}-${candidate.id}`} className={`${styles.result} ${preview?.id === candidate.id && preview.provider === candidate.provider ? styles.selected : ""}`} disabled={Boolean(busy)} onClick={() => inspect(candidate)} aria-label={`Preview ${candidate.name}${candidate.year ? ` (${candidate.year})` : ""}`}>
      <span className={styles.art}>{candidate.posterUrl ? <img src={candidate.posterUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = "hidden"; }} /> : <span aria-hidden="true">◇</span>}</span><span className={styles.resultText}><strong>{candidate.name}</strong><span>{candidate.year ?? "Year unknown"} · {candidate.type === "series" ? "Series" : "Movie"}</span><small>{PROVIDER_LABELS[candidate.provider]}</small></span><span className={styles.inspect}>Preview ↗</span>
    </button>)}</div>}
    {preview && <section className={styles.preview} aria-label="Metadata preview">
      <div className={styles.previewHeader}><div><span className={styles.eyebrow}>REVIEW BEFORE APPLYING</span><h4>{preview.name} {preview.year && <span>({preview.year})</span>}</h4><p>{preview.genres.join(" · ") || (preview.type === "movie" ? "Movie" : "Series")}</p></div><span className={styles.providerBadge}>{PROVIDER_LABELS[preview.provider]}</span></div>
      <p className={styles.overview}>{preview.description || "This provider did not return an overview."}</p>
      <div className={styles.facts}>{preview.runtimeMinutes !== null && <span>{preview.runtimeMinutes} min</span>}{preview.rating !== null && <span>★ {preview.rating.toFixed(1)} / 10{preview.ratingSource ? ` · ${preview.ratingSource}` : ""}</span>}{preview.contentRating && <span>{preview.contentRating}</span>}{imdb && <a href={imdb} target="_blank" rel="noreferrer">View IMDb ↗</a>}</div>
      {preview.cast.length > 0 && <p className={styles.cast}><strong>Cast</strong> {preview.cast.join(" · ")}</p>}
      <p className={styles.policy}>{target?.type === "account" ? "Updates your private library details. Existing torrents and files stay in your debrid account." : target?.type === "library" ? "Adds metadata to the web library. Export names, symlinks, and source files stay under your control." : target ? "Updates unlocked metadata fields. Playback sources and manually locked fields are preserved." : "Copies these details into your draft for review. Save the title separately to keep them."}</p>
      <button type="button" className="btn" disabled={Boolean(busy)} onClick={apply}>{target ? "Use this match" : "Use metadata in draft"}</button>
    </section>}
    <footer className={styles.attribution}><img src="/metadata/tmdb.svg" alt="TMDB" width={80} height={20} /> Metadata supplied by TMDB or OMDb. IMDb links identify the matched work. This product uses the TMDB API but is not endorsed or certified by TMDB.</footer>
  </section>;
}
