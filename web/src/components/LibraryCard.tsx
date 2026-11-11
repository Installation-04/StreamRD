"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMedia, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import gallery from "@/app/library/library.module.css";

const Heart = ({ size }: { size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" /></svg>;

/** For the administrator: a title whose metadata match needs a decision. */
export const MATCH_TO_FIX: Record<string, string> = { review: "Review match", unmatched: "No match found", error: "Match error" };

/** The heart on a title: adds it to, or takes it off, the viewer's own list (My List). */
export function FavoriteButton({ libraryId, item, onChange }: { libraryId: string; item: Pick<AccountMedia, "id" | "name" | "favorite">; onChange?: (favorite: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), on = Boolean(item.favorite);
  async function toggle() {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      const result = await api<{ favorite: boolean }>(`/api/shared-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(item.id)}/favorite`, { method: on ? "DELETE" : "PUT" });
      onChange?.(result.favorite);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <button type="button" className={`${gallery.heart} ${on ? gallery.heartOn : ""}`} aria-pressed={on} aria-label={on ? `Remove ${item.name} from My List` : `Add ${item.name} to My List`} title={error ? "Your list could not be updated. Try again." : on ? "On My List" : "Add to My List"} disabled={busy} onClick={() => void toggle()}><Heart size={18} /></button>;
}

/** The same action as a labelled button, for a title's own page. */
export function FavoriteToggle({ libraryId, item, onChange }: { libraryId: string; item: Pick<AccountMedia, "id" | "name" | "favorite">; onChange?: (favorite: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), on = Boolean(item.favorite);
  async function toggle() {
    if (busy) return;
    setBusy(true); setError(false);
    try { onChange?.((await api<{ favorite: boolean }>(`/api/shared-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(item.id)}/favorite`, { method: on ? "DELETE" : "PUT" })).favorite); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="btn btn-secondary" aria-pressed={on} disabled={busy} onClick={() => void toggle()}><Heart size={16} /> {on ? "On My List" : "Add to My List"}</button>
    {error && <span role="alert" style={{ fontSize: 13, opacity: 0.8 }}>Your list could not be updated. Try again.</span>}
  </>;
}

/** Marks a title watched or unwatched for the viewer (StreamRD only: the server leaves `watched` out where nothing can be played). */
export function WatchedToggle({ libraryId, item, onChange }: { libraryId: string; item: Pick<AccountMedia, "id" | "watched">; onChange?: (watched: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), on = Boolean(item.watched);
  if (item.watched === undefined) return null;
  async function toggle() {
    if (busy) return;
    setBusy(true); setError(false);
    try { onChange?.((await api<{ watched: boolean }>(`/api/shared-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(item.id)}/watched`, { method: on ? "DELETE" : "PUT" })).watched); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="btn btn-secondary" aria-pressed={on} disabled={busy} onClick={() => void toggle()}>{on ? "✓ Watched · mark unwatched" : "Mark as watched"}</button>
    {error && <span role="alert" style={{ fontSize: 13, opacity: 0.8 }}>Could not update. Try again.</span>}
  </>;
}

/** Watch trailer on a title's page (StreamRD). The trailer is looked up by the server; YouTube is contacted by the browser only after the button is pressed. */
export function TrailerButton({ libraryId, item }: { libraryId: string; item: Pick<AccountMedia, "id" | "name" | "year" | "watched"> }) {
  const [trailer, setTrailer] = useState<string | null>(null), [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false), enabled = item.watched !== undefined;
  useEffect(() => {
    if (!enabled) return;
    let live = true; setTrailer(null); setLoaded(false);
    api<{ trailer: string | null }>(`/api/shared-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(item.id)}/trailer`).then(result => { if (live) { setTrailer(result.trailer); setLoaded(true); } }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [enabled, libraryId, item.id]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [open]);
  if (!enabled || !loaded) return null;
  if (!trailer) return <a className="btn btn-secondary" href={`https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.name}${item.year ? ` ${item.year}` : ""} official trailer`)}`} target="_blank" rel="noreferrer noopener">Find trailer ↗</a>;
  return <>
    <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>▶ Watch trailer</button>
    {open && <div role="dialog" aria-modal="true" aria-label={`Trailer: ${item.name}`} onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.88)", display: "grid", placeItems: "center", padding: 16 }}>
      <div onClick={event => event.stopPropagation()} style={{ width: "min(1100px, 100%)", display: "grid", gap: 12 }}>
        <div style={{ aspectRatio: "16 / 9", width: "100%" }}><iframe title={`Trailer: ${item.name}`} src={`https://www.youtube-nocookie.com/embed/${trailer}?autoplay=1&playsinline=1&rel=0&modestbranding=1&controls=1`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" style={{ width: "100%", height: "100%", border: 0, borderRadius: 12 }} /></div>
        <button type="button" className="btn btn-secondary" autoFocus onClick={() => setOpen(false)} style={{ justifySelf: "end" }}>Close trailer</button>
      </div>
    </div>}
  </>;
}

/** One title in a library grid or on My List: the card, and the heart beside it. */
export default function LibraryCard({ libraryId, item, onFavorite }: { libraryId: string; item: AccountMedia; onFavorite?: (favorite: boolean) => void }) {
  const name = accountMediaName(item), poster = safeMediaUrl(item.metadata?.posterUrl), ready = item.phase === "finished", { user } = useAuth(), fix = user?.role === "admin" ? MATCH_TO_FIX[item.metadataStatus ?? ""] : undefined;
  return <div className={gallery.cardWrap}>
    <Link href={`/shared-libraries/${encodeURIComponent(libraryId)}/${encodeURIComponent(item.id)}`} className={gallery.card} aria-label={`Open ${name}`}><div className={`${gallery.poster} ${gallery[`color${item.id.charCodeAt(item.id.length - 1) % 4}`]}`}><div className={gallery.posterFallback} aria-hidden="true"><span>{item.type === "series" ? "SERIES" : "FILM"}</span><strong>{name}</strong><i>{item.year ?? "SERVER COLLECTION"}</i></div>{poster && <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = "none"; }} onLoad={event => { event.currentTarget.style.display = ""; }} />}<span className={gallery.provider}>SHARED BY YOUR SERVER</span><span className={`${gallery.readiness} ${ready && item.health !== "broken" ? gallery.ready : ""}`}>{item.health === "broken" ? "Link needs attention" : ready ? "Provider reports ready" : item.phase === "error" ? "Needs attention" : `${item.phase === "downloading" ? "Downloading" : "Queued"} · ${Math.max(0, Math.min(100, item.progress))}%`}</span><span className={gallery.badges}>{item.health === "broken" && <span className={gallery.alertBad}>⚠ Link broken</span>}{fix && <span className={gallery.alertWarn}>{fix}</span>}{item.tags?.find(tag => tag.kind === "resolution") && <span className={gallery.resolutionTag}>{item.tags.find(tag => tag.kind === "resolution")!.label}</span>}{item.watched && <span className={gallery.watchedBadge}>✓ Watched</span>}</span><span className={gallery.open}><span aria-hidden="true">↗</span> View title</span></div><div className={gallery.cardInfo}><h2>{name}</h2><p>{item.year ?? item.metadata?.year ?? "Year unknown"}<span>·</span>{item.type === "series" ? "Series" : "Movie"}{item.metadata?.rating != null && <><span>·</span>★ {item.metadata.rating.toFixed(1)}</>}</p></div></Link>
    <FavoriteButton libraryId={libraryId} item={{ id: item.id, name, favorite: item.favorite }} onChange={onFavorite} />
  </div>;
}
