"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMedia, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import { SharedContinueItem, SharedLibrary, SharedLibraryItems, libraryTypeLabel } from "@/lib/shared-libraries";
import LibraryCard from "@/components/LibraryCard";
import styles from "./SharedLibraries.module.css";
import gallery from "@/app/library/library.module.css";

export default function SharedLibraries({ libraryId }: { libraryId?: string }) {
  const { user, loading: authLoading } = useAuth(), router = useRouter();
  const [libraries, setLibraries] = useState<SharedLibrary[]>([]), [items, setItems] = useState<AccountMedia[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [query, setQuery] = useState(""), [type, setType] = useState("all"), [needsAttention, setNeedsAttention] = useState(false), [attention, setAttention] = useState<{ match: number; links: number } | null>(null), [unwatched, setUnwatched] = useState(false);
  const [resume, setResume] = useState<SharedContinueItem[]>([]);
  const [total, setTotal] = useState(0), [cursor, setCursor] = useState<string | null>(null), [loadedMore, setLoadedMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (next?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError("");
    try {
      const response = await api<{ libraries: SharedLibrary[] }>("/api/shared-libraries", { signal: controller.signal });
      if (controller.signal.aborted) return;
      setLibraries(response.libraries);
      if (!libraryId) api<{ items: SharedContinueItem[] }>("/api/shared-libraries/continue", { signal: controller.signal }).then(next => { if (!controller.signal.aborted) setResume(next.items); }).catch(() => { if (!controller.signal.aborted) setResume([]); });
      if (libraryId) {
        if (!response.libraries.some(library => library.id === libraryId)) { setItems([]); setTotal(0); setCursor(null); throw new Error("This library is unavailable. Ask the server owner to check your access."); }
        const params = new URLSearchParams({ limit: "30" });
        if (query.trim()) params.set("q", query.trim()); if (type !== "all") params.set("type", type); if (needsAttention) params.set("attention", "1"); if (unwatched) params.set("unwatched", "1"); if (next) params.set("cursor", next);
        const page = await api<SharedLibraryItems>(`/api/shared-libraries/${encodeURIComponent(libraryId)}/items?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setItems(current => next ? [...current.filter(item => !page.items.some(other => other.id === item.id)), ...page.items].slice(-200) : page.items);
        setTotal(page.total); setAttention(page.attention ?? null); setCursor(page.nextCursor); setLoadedMore(Boolean(next));
      }
    } catch (reason) { if (!controller.signal.aborted) { if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { setLibraries([]); setItems([]); setTotal(0); setCursor(null); } setError(reason instanceof Error ? reason.message : "Shared libraries could not be loaded."); } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [libraryId, query, type, unwatched, needsAttention]);
  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
    if (!user) return;
    const timer = setTimeout(() => void load(), libraryId ? 250 : 0);
    return () => { clearTimeout(timer); request.current?.abort(); };
  }, [user, authLoading, router, load, libraryId]);
  if (authLoading || !user) return <main className={styles.page}><p role="status">Checking your account…</p></main>;
  const library = libraries.find(candidate => candidate.id === libraryId);
  return <main className={styles.page}>
    {libraryId && <Link className={styles.back} href="/shared-libraries">← Libraries</Link>}
    <header className={styles.intro}><div><p className={styles.eyebrow}>FROM YOUR SERVER. READY TO WATCH.</p><h1>{libraryId ? library?.name ?? "Library" : "Libraries."}</h1><p>{libraryId ? "A collection shared with you by this server. Browse its titles and press Play; your server handles the connection." : "Your invitation opens the door. Explore the collections your server owner has shared with you, with no personal debrid account needed."}</p></div><div className={styles.introActions}>{user.role === "admin" && <Link className="btn btn-secondary" href="/admin/shared-libraries">Manage sharing</Link>}<button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load()}>Refresh libraries</button></div></header>
    {error && <div className={styles.error} role="alert"><p>{error}</p><button type="button" disabled={loading} onClick={() => void load()}>Try again</button></div>}
    {loading && !libraries.length && <section className={styles.notice} role="status">Opening your server’s collections…</section>}
    {!libraryId && <>
      {!loading && !error && !libraries.length && <section className={styles.empty}><p className={styles.eyebrow}>YOUR SEAT IS SAVED</p><h2>No libraries shared yet.</h2><p>{user.role === "admin" ? "Create a shared library from your imported account collection, then choose who can watch." : "Your account is ready. Ask the server owner to give you access to a library; you don’t need to connect a provider."}</p>{user.role === "admin" && <Link className="btn" href="/admin/shared-libraries">Create a shared library</Link>}</section>}
      {resume.length > 0 && <section className={styles.libraryGrid} aria-label="Continue watching" style={{ marginBottom: "2rem" }}>{resume.map(entry => { const name = accountMediaName(entry.item), percent = Math.max(1, Math.min(99, Math.round(entry.positionSeconds / Math.max(1, entry.durationSeconds) * 100))); return <Link key={entry.item.id} href={`/shared-libraries/${encodeURIComponent(entry.libraryId)}/${encodeURIComponent(entry.item.id)}`} className={styles.libraryTile} aria-label={`Continue watching ${name}`}><div className={styles.tileArt}><span className={styles.tileIcon} aria-hidden="true">▶</span><span>Pick up where you left off</span></div><div className={styles.tileCopy}><h2>{name}</h2><p><span>{percent}% watched</span><span>Resume ↗</span></p></div></Link>; })}</section>}
      <section className={styles.libraryGrid} aria-label="Libraries shared with you" aria-busy={loading}>{libraries.map(collection => <Link key={collection.id} href={`/shared-libraries/${encodeURIComponent(collection.id)}`} className={styles.libraryTile} aria-label={`Open library ${collection.name}`}><div className={styles.tileArt}><span className={styles.tileIcon} aria-hidden="true">{collection.mediaType === "series" ? "▤" : "◈"}</span><span>{libraryTypeLabel(collection.mediaType)}</span></div><div className={styles.tileCopy}><h2>{collection.name}</h2><p><span>{collection.itemCount} {collection.itemCount === 1 ? "title" : "titles"}</span><span>Explore collection ↗</span></p></div></Link>)}</section>
    </>}
    {libraryId && library && <>
      <section className={gallery.toolbar} aria-label="Shared library filters"><label className={gallery.search}><span>Find your next watch</span><input type="search" aria-label="Search shared library" value={query} maxLength={160} placeholder="Search titles…" onChange={event => setQuery(event.target.value)} /></label>{library.mediaType === "all" && <label className={gallery.type}><span>Show</span><select aria-label="Filter shared library by type" value={type} onChange={event => setType(event.target.value)}><option value="all">Everything</option><option value="movie">Movies</option><option value="series">Series</option></select></label>}<label className={gallery.type}><span>Show</span><select aria-label="Filter by watched" value={unwatched ? "unwatched" : "all"} onChange={event => setUnwatched(event.target.value === "unwatched")}><option value="all">All titles</option><option value="unwatched">Unwatched</option></select></label><div className={gallery.total}><strong>{total}</strong><span>{total === 1 ? "title" : "titles"}</span></div></section>
      {loading && !items.length && <div className={gallery.skeleton} role="status">Gathering this collection…</div>}
      {!loading && !items.length && !error && <section className={styles.empty}><h2>{query || type !== "all" ? "No titles match this view." : "This collection is getting started."}</h2><p>{query || type !== "all" ? "Try another title or clear your filters." : "Titles appear here as the server’s account library is imported. Check back soon."}</p>{(query || type !== "all") && <button type="button" className="btn btn-secondary" onClick={() => { setQuery(""); setType("all"); }}>Clear filters</button>}</section>}
      {attention && (attention.match > 0 || attention.links > 0 || needsAttention) && <section className={styles.notice} role="status" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, borderColor: "#c0392b" }}>
        <span><strong>⚠ Needs your attention:</strong>{" "}{attention.match > 0 && `${attention.match} ${attention.match === 1 ? "title needs" : "titles need"} a match`}{attention.match > 0 && attention.links > 0 && " · "}{attention.links > 0 && `${attention.links} broken ${attention.links === 1 ? "link" : "links"} (a replacement is requested automatically)`}{attention.match === 0 && attention.links === 0 && "nothing right now"}</span>
        <button type="button" className="btn btn-secondary" aria-pressed={needsAttention} onClick={() => setNeedsAttention(value => !value)}>{needsAttention ? "Show all titles" : "Show only these"}</button>
      </section>}
      <section className={gallery.grid} aria-label="Shared library titles" aria-busy={loading}>{items.map(item => {
        return <LibraryCard key={item.id} libraryId={libraryId} item={item} onFavorite={favorite => setItems(list => list.map(row => row.id === item.id ? { ...row, favorite } : row))} />;
      })}</section>
      {(cursor || loadedMore) && <div className={gallery.more}><p>Showing {items.length} loaded titles. This view keeps up to 200; search or Refresh libraries to return to the first page.</p>{cursor && <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load(cursor)}>{loading ? "Loading…" : "Load more titles"}</button>}</div>}
    </>}
    <footer className={styles.notice}><strong>One server, a shared collection.</strong> Your access is managed by the server owner. Playback uses the server’s configured account; your personal connections and private library remain separate.</footer>
  </main>;
}
