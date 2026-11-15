"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { safeMediaUrl } from "@/lib/account-library";
import styles from "./Requests.module.css";

interface Album { id: string; title: string; artist: string; year: number | null; kind: string; coverUrl: string | null; status: "available" | "requested" | null }
const STATE: Record<string, string> = { available: "In your library", requested: "Requested" };

/** Whether the server can search music (Lidarr is installed and running); the page offers music only then. */
export function useMusicAvailable(enabled: boolean) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) return; let live = true;
    api<{ available: boolean }>("/api/music/status").then(found => { if (live) setAvailable(found.available); }).catch(() => undefined);
    return () => { live = false; };
  }, [enabled]);
  return available;
}

/** Album results for a search, each with one Request button. Lidarr finds and downloads what is asked for; nothing here needs a metadata account. */
export function MusicResults({ query }: { query: string }) {
  const [results, setResults] = useState<Album[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [asking, setAsking] = useState(""), [asked, setAsked] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    if (query.trim().length < 2) { setResults([]); setBusy(false); setError(""); return; }
    setBusy(true); setError("");
    const timer = setTimeout(() => {
      api<{ results: Album[] }>(`/api/music/search?${new URLSearchParams({ q: query.trim() })}`, { signal: controller.signal })
        .then(found => { if (!controller.signal.aborted) setResults(found.results); })
        .catch(reason => { if (!controller.signal.aborted) { setError((reason as Error).message); setResults([]); } })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  async function ask(album: Album) {
    if (asking) return; setAsking(album.id); setError("");
    try { const made = await api<{ status: string }>("/api/music/request", { method: "POST", body: JSON.stringify({ id: album.id }) }); setAsked(current => ({ ...current, [album.id]: made.status })); }
    catch (reason) { setError((reason as Error).message); }
    finally { setAsking(""); }
  }
  return <>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {busy && <p role="status" className={styles.small}>Searching music…</p>}
    {!busy && !error && query.trim().length >= 2 && <p className={styles.small} aria-live="polite">{results.length} {results.length === 1 ? "album" : "albums"} · Request one and it is downloaded into your music folder.</p>}
    <section className={styles.results} aria-label="Music results" aria-busy={busy}>
      {results.map(album => {
        const state = asked[album.id] ?? album.status, image = safeMediaUrl(album.coverUrl);
        return <div className={styles.resultItem} key={album.id} data-album={album.id}>
          <div className={styles.mediaCard}>
            <div className={`${styles.poster} ${styles.cover}`}><span aria-hidden="true">{album.title}</span>{image && <img src={image} alt={`${album.title} cover`} loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}</div>
            <div><h2>{album.title}</h2><p>{album.artist}{album.year ? ` · ${album.year}` : ""}{album.kind ? ` · ${album.kind}` : ""}</p></div>
          </div>
          {!state ? <button type="button" className="btn btn-sm" disabled={Boolean(asking)} aria-label={`Request ${album.title} by ${album.artist}`} onClick={() => void ask(album)}>{asking === album.id ? "Requesting…" : "Request"}</button>
            : <span className={styles.resultState} data-state={state}>{STATE[state] ?? state}</span>}
        </div>;
      })}
    </section>
    {!busy && !error && !results.length && <section className={styles.empty}><p className={styles.eyebrow}>MUSIC</p><h2>{query.trim().length >= 2 ? "No matching albums yet." : "What would you like to hear?"}</h2><p>{query.trim().length >= 2 ? "Try the artist and the album together, for example “Radiohead OK Computer”." : "Search for an artist and an album. A requested album is searched for and downloaded by Lidarr."}</p></section>}
  </>;
}
