"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { del, get, post } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { SavedSearch, SearchResult } from "@/lib/types";

type SortKey = "seeders" | "size" | "date";
type SearchOptions = { query: string; minSeeders: string; maxSizeGb: string; sort: SortKey };
export default function SearchPage() {
  const [q, setQ] = useState(""), [minSeeders, setMinSeeders] = useState("0"), [maxSizeGb, setMaxSizeGb] = useState("");
  const [sort, setSort] = useState<SortKey>("seeders"), [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<string[]>([]), [busy, setBusy] = useState(false), [searched, setSearched] = useState<string | null>(null);
  const [adding, setAdding] = useState<Set<string>>(new Set()), [added, setAdded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]), [saving, setSaving] = useState(false), [saveOpen, setSaveOpen] = useState(false), [saveName, setSaveName] = useState("");
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const sequence = useRef(0);
  const addLocks = useRef(new Set<string>());
  useEffect(() => {
    let closed = false;
    get<{ savedSearches: SavedSearch[] }>("/api/account/saved-searches").then(res => { if (!closed) setSavedSearches(res.savedSearches); }).catch(() => { /* Search is available even when saved searches cannot load. */ });
    return () => { closed = true; sequence.current++; };
  }, []);
  async function runSearch(options: SearchOptions) {
    if (!options.query.trim()) return;
    const current = ++sequence.current;
    setBusy(true); setErrors([]); setActionError(null); setMessage(null); setSearched(options.query.trim());
    try {
      const params = new URLSearchParams({ q: options.query.trim(), sort: options.sort });
      if (options.minSeeders) params.set("minSeeders", options.minSeeders);
      if (options.maxSizeGb) params.set("maxSizeGb", options.maxSizeGb);
      const res = await get<{ results: SearchResult[]; errors: string[] }>(`/api/search?${params}`);
      if (current !== sequence.current) return;
      setResults(res.results); setErrors(res.errors);
    } catch (err) { if (current === sequence.current) { setResults([]); setErrors([(err as Error).message]); } }
    finally { if (current === sequence.current) setBusy(false); }
  }
  async function saveSearch(e: React.FormEvent) {
    e.preventDefault(); if (!saveName.trim() || !q.trim() || saving) return;
    setSaving(true); setActionError(null);
    try {
      const res = await post<{ savedSearch: SavedSearch }>("/api/account/saved-searches", { name: saveName.trim(), query: q.trim(), minSeeders: minSeeders ? Number(minSeeders) : undefined, maxSizeGb: maxSizeGb ? Number(maxSizeGb) : undefined, sort });
      setSavedSearches(previous => [res.savedSearch, ...previous]); setSaveOpen(false); setMessage(`Saved “${res.savedSearch.name}”.`);
    } catch (err) { setActionError((err as Error).message); }
    finally { setSaving(false); }
  }
  function runSaved(saved: SavedSearch) {
    const options = { query: saved.query, minSeeders: String(saved.minSeeders ?? 0), maxSizeGb: saved.maxSizeGb == null ? "" : String(saved.maxSizeGb), sort: saved.sort };
    setQ(options.query); setMinSeeders(options.minSeeders); setMaxSizeGb(options.maxSizeGb); setSort(options.sort);
    void runSearch(options);
  }
  async function deleteSaved(id: string) {
    setDeleting(previous => new Set(previous).add(id)); setActionError(null);
    try { await del(`/api/account/saved-searches/${id}`); setSavedSearches(previous => previous.filter(saved => saved.id !== id)); }
    catch (err) { setActionError(`Could not remove saved search: ${(err as Error).message}`); }
    finally { setDeleting(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  }
  async function addToQueue(result: SearchResult) {
    if (addLocks.current.has(result.link) || added.has(result.link)) return;
    addLocks.current.add(result.link); setAdding(new Set(addLocks.current)); setActionError(null); setMessage(null);
    try {
      const res = await post<{ job: { id: string; status: string } }>("/api/downloads", { title: result.title, sourceUrl: result.link, sizeBytes: result.sizeBytes, seeders: result.seeders, indexerName: result.indexerName });
      setAdded(previous => new Set(previous).add(result.link)); setMessage(`“${result.title}” added to your queue (${res.job.status}).`);
    } catch (err) { setActionError(`Could not add to queue: ${(err as Error).message}`); }
    finally { addLocks.current.delete(result.link); setAdding(new Set(addLocks.current)); }
  }
  const options = { query: q, minSeeders, maxSizeGb, sort };
  return <main className="container workspace">
    <header className="page-heading"><div><p className="eyebrow">DISCOVERY / INDEXER SEARCH</p><h1>Find your next signal<span className="accent">.</span></h1><p className="page-description">Search your indexers. Send it to debrid. Make it movie night.</p></div><Link href="/downloads" className="btn btn-quiet">Open queue <span aria-hidden="true">↗</span></Link></header>
    <section className="search-console" aria-label="Search your indexers">
      <form className="search-bar" onSubmit={e => { e.preventDefault(); void runSearch(options); }}>
        <label className="search-input-wrap"><span className="search-prompt" aria-hidden="true">⌕</span><span className="sr-only">Search query</span><input type="search" placeholder="Search movies, shows, or anything else…" maxLength={500} required value={q} onChange={e => setQ(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || !q.trim()}>{busy ? "Searching…" : "Search indexers"}<span aria-hidden="true">↗</span></button>
      </form>
      <div className="filters">
        <label htmlFor="minimum-seeders">Min. seeders<input id="minimum-seeders" type="number" min={0} max={2147483647} value={minSeeders} onChange={e => setMinSeeders(e.target.value)} /></label>
        <label htmlFor="maximum-size">Max. size / GB<input id="maximum-size" type="number" min={0} step="any" placeholder="Any size" value={maxSizeGb} onChange={e => setMaxSizeGb(e.target.value)} /></label>
        <label htmlFor="search-sort">Sort by<select id="search-sort" value={sort} onChange={e => setSort(e.target.value as SortKey)}><option value="seeders">Most seeders</option><option value="size">Largest size</option><option value="date">Newest first</option></select></label>
        <button type="button" className="btn btn-quiet save-trigger" disabled={!q.trim() || savedSearches.length >= 20} onClick={() => { setSaveName(q); setSaveOpen(!saveOpen); }}>☆ Save search</button>
      </div>
      {saveOpen && <form className="inline-save" onSubmit={saveSearch}><div className="field"><label htmlFor="saved-search-name">Name this search</label><input id="saved-search-name" autoFocus required maxLength={80} value={saveName} onChange={e => setSaveName(e.target.value)} /></div><button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button><button type="button" className="btn btn-quiet" disabled={saving} onClick={() => setSaveOpen(false)}>Cancel</button></form>}
    </section>
    {savedSearches.length > 0 && <section className="saved-search-section" aria-label="Saved searches"><p className="eyebrow">YOUR FREQUENCIES <span>{savedSearches.length}/20</span></p><div className="saved-searches">{savedSearches.map(saved => <span className="saved-search-chip" key={saved.id}><button type="button" disabled={busy || deleting.has(saved.id)} onClick={() => runSaved(saved)} title={`Search for ${saved.query}`}><span aria-hidden="true">↻</span> {saved.name}</button><button type="button" disabled={deleting.has(saved.id)} className="saved-search-delete" onClick={() => void deleteSaved(saved.id)} aria-label={`Remove saved search ${saved.name}`}>×</button></span>)}</div></section>}
    {message && <div className="notice notice-success" role="status"><span>{message}</span><Link href="/downloads">View queue →</Link></div>}
    {actionError && <p className="notice notice-error" role="alert">{actionError}</p>}
    {errors.length > 0 && <div className="notice notice-error" role="alert"><strong>{results.length ? "Some indexers could not respond" : "Search needs attention"}</strong>{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
    <section aria-label="Search results" aria-busy={busy}>
      <div className="section-heading"><h2>{searched ? "Search results" : "Your next watch starts here"}</h2>{searched && !busy && <span className="result-count">{results.length} result{results.length === 1 ? "" : "s"}</span>}</div>
      {busy ? <div className="results-loading" role="status"><span className="activity-indicator" />Searching connected indexers…<p className="dim">Available results will appear when the search completes.</p></div> : results.length > 0 ? <div className="result-list">{results.map(result => <article className="result-row" key={`${result.indexerId}-${result.link}`}>
        <div className="result-icon" aria-hidden="true">↗</div><div className="result-content"><h3 className="result-title">{result.title}</h3><div className="result-meta"><span className="result-indexer">{result.indexerName}</span><span>{formatBytes(result.sizeBytes)}</span><span className="seed-count">↑ {result.seeders} seed{result.seeders === 1 ? "" : "s"}</span>{result.publishedAt && !Number.isNaN(Date.parse(result.publishedAt)) && <time dateTime={new Date(result.publishedAt).toISOString()}>{new Date(result.publishedAt).toLocaleDateString()}</time>}</div></div>
        {result.hasMagnet ? <button className={`btn btn-sm ${added.has(result.link) ? "btn-quiet" : "btn-primary"}`} disabled={adding.has(result.link) || added.has(result.link)} aria-label={added.has(result.link) ? `${result.title} added to queue` : `Add ${result.title} to queue`} onClick={() => void addToQueue(result)}>{adding.has(result.link) ? "Adding…" : added.has(result.link) ? "✓ Added" : "+ Add to queue"}</button> : <span className="pill pill-dim">No magnet link</span>}
      </article>)}</div> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">{searched ? "∅" : "⌕"}</span><h3>{searched ? `No results for “${searched}”` : "A world of media, one search away."}</h3><p>{searched ? "Try another title, fewer filters, or a different spelling. Check that your indexers are enabled if nothing comes back." : "Enter a title above to search your connected indexers. Save your favorite searches to find them again in a click."}</p><div className="empty-actions"><Link href="/account/debrid" className="btn btn-quiet">Connect debrid</Link><Link href="/account/profile" className="text-link">Account settings →</Link></div></div>}
    </section>
    <footer className="workspace-footer"><span>PHOSPHOR / YOUR PERSONAL MEDIA TERMINAL</span><span>Results come from your configured indexers.</span></footer>
  </main>;
}
