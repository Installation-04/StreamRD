"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ACCOUNT_PROVIDER_NAMES, AccountLibraryPage, AccountMedia, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import AccountScanPanel from "@/components/AccountScanPanel";
import styles from "./library.module.css";

export default function AccountLibraryPageView() {
  const { user, loading: authLoading } = useAuth(), router = useRouter();
  const [items, setItems] = useState<AccountMedia[]>([]), [total, setTotal] = useState(0), [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [type, setType] = useState("all"), [loading, setLoading] = useState(true), [error, setError] = useState(""), [scanOpen, setScanOpen] = useState(false), [loadedMore, setLoadedMore] = useState(false);
  const request = useRef<AbortController | null>(null), mounted = useRef(false), importCount = useRef(-1);
  const load = useCallback(async (next?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError("");
    const params = new URLSearchParams({ limit: "30" }); if (query.trim()) params.set("q", query.trim()); if (type !== "all") params.set("type", type); if (next) params.set("cursor", next);
    try {
      const page = await api<AccountLibraryPage>(`/api/account/library?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      setItems(current => next ? [...current.filter(item => !page.items.some(other => other.id === item.id)), ...page.items].slice(-200) : page.items);
      setTotal(page.total); setCursor(page.nextCursor); setLoadedMore(Boolean(next));
    } catch (reason) { if (!controller.signal.aborted && mounted.current) setError(reason instanceof Error ? reason.message : "Your library could not be loaded. Try again."); }
    finally { if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }, [query, type]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { if (!authLoading && !user) router.replace("/login"); if (!user) return; const timer = setTimeout(() => void load(), 250); return () => { clearTimeout(timer); request.current?.abort(); }; }, [user, authLoading, router, load]);
  if (authLoading || !user) return <main className={styles.page}><p role="status">Checking your account…</p></main>;
  return <main className={styles.page}>
    <header className={styles.header}><div><p className={styles.eyebrow}>ALREADY IN YOUR ACCOUNT. READY TO DISCOVER.</p><h1>My library<span>.</span></h1><p>Your debrid accounts, together in one private collection. Artwork and details appear as metadata is matched.</p></div><div className={styles.headerActions}><Link className="btn btn-secondary" href="/account/debrid">Connections</Link><button type="button" className="btn" aria-expanded={scanOpen} aria-controls="library-scans" onClick={() => setScanOpen(open => !open)}>{scanOpen ? "Hide account scans" : "Scan my accounts"}</button></div></header>
    <div id="library-scans" hidden={!scanOpen}><AccountScanPanel onChanged={count => { if (importCount.current !== -1 && count !== importCount.current) void load(); importCount.current = count; }} /></div>
    <section className={styles.toolbar} aria-label="Library filters"><label className={styles.search}><span>Find something in your library</span><input type="search" aria-label="Search my library" value={query} maxLength={160} placeholder="Search titles…" onChange={event => setQuery(event.target.value)} /></label><label className={styles.type}><span>Show</span><select aria-label="Filter my library by type" value={type} onChange={event => setType(event.target.value)}><option value="all">Everything</option><option value="movie">Movies</option><option value="series">Series</option></select></label><div className={styles.total}><strong>{total}</strong><span>{total === 1 ? "title" : "titles"}</span></div><button type="button" className={styles.textButton} disabled={loading} onClick={() => void load()}>Refresh library</button></section>
    {error && <div className={styles.error} role="alert"><p>{error}</p><button type="button" disabled={loading} onClick={() => void load()}>Try again</button></div>}
    {loading && !items.length && <div className={styles.skeleton} role="status">Gathering your collection…</div>}
    {!loading && !items.length && !error && <section className={styles.empty}><span className={styles.emptyIcon} aria-hidden="true">◇</span><p className={styles.eyebrow}>YOUR NEXT WATCH STARTS HERE</p><h2>{query || type !== "all" ? "No titles match this view." : "Your library is waiting for you."}</h2><p>{query || type !== "all" ? "Try another name or show everything in your collection." : "Connect your own debrid account. Existing torrents can be imported automatically during setup, with no new transfers or local media mount required."}</p><div>{query || type !== "all" ? <button className="btn btn-secondary" onClick={() => { setQuery(""); setType("all"); }}>Clear filters</button> : <><Link className="btn" href="/account/debrid">Connect an account</Link><button className="btn btn-secondary" onClick={() => setScanOpen(true)}>Check account scans</button></>}</div></section>}
    <section className={styles.grid} aria-label="Private account library" aria-busy={loading}>{items.map(item => {
      const name = accountMediaName(item), poster = safeMediaUrl(item.metadata?.posterUrl), ready = item.phase === "finished";
      return <Link key={item.id} href={`/library/${encodeURIComponent(item.id)}`} className={styles.card} aria-label={`Open ${name}`}>
        <div className={`${styles.poster} ${styles[`color${item.id.charCodeAt(item.id.length - 1) % 4}`]}`}><div className={styles.posterFallback} aria-hidden="true"><span>{item.type === "series" ? "SERIES" : "FILM"}</span><strong>{name}</strong><i>{item.year ?? "YOUR COLLECTION"}</i></div>{poster && <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = "none"; }} />}<span className={styles.provider}>{ACCOUNT_PROVIDER_NAMES[item.provider] ?? "Debrid"}</span><span className={`${styles.readiness} ${ready ? styles.ready : ""}`}>{ready ? "In your account" : item.phase === "error" ? "Needs attention" : `${item.phase === "downloading" ? "Downloading" : "Queued"} · ${Math.max(0, Math.min(100, item.progress))}%`}</span><span className={styles.open}><span aria-hidden="true">↗</span> View title</span></div>
        <div className={styles.cardInfo}><h2>{name}</h2><p>{item.year ?? item.metadata?.year ?? "Year unknown"}<span>·</span>{item.type === "series" ? "Series" : "Movie"}{item.metadata?.rating != null && <><span>·</span>★ {item.metadata.rating.toFixed(1)}</>}</p></div>
      </Link>;
    })}</section>
    {(cursor || loadedMore) && <div className={styles.more}><p>Showing {items.length} loaded titles. This view keeps up to 200; search or Refresh library to return to the first page.</p>{cursor && <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load(cursor)}>{loading ? "Loading…" : "Load more titles"}</button>}</div>}
    <footer className={styles.footer}><span>PRIVATE TO YOUR ACCOUNT</span><p>Imported titles stay in your personal library. A provider’s ready status is not a playback test. Choose a title to resolve a fresh stream using your own credentials.</p></footer>
  </main>;
}
