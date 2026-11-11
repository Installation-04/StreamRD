"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMedia, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import { imdbLink, metadataSourceLink, PROVIDER_LABELS } from "@/lib/metadata";
import { SharedLibrary, TitleVersion } from "@/lib/shared-libraries";
import { FavoriteToggle, MATCH_TO_FIX, TrailerButton, WatchedToggle } from "@/components/LibraryCard";
import styles from "@/app/library/[id]/detail.module.css";

export default function SharedLibraryDetail() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>(), { user, loading: authLoading } = useAuth(), router = useRouter();
  const [library, setLibrary] = useState<SharedLibrary | null>(null);
  const [versions, setVersions] = useState<TitleVersion[]>([]);
  const [item, setItem] = useState<AccountMedia | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const mounted = useRef(false), request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    try {
      const response = await api<{ item: AccountMedia; library: SharedLibrary; versions?: TitleVersion[] }>(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return; setItem(response.item); setLibrary(response.library); setVersions(response.versions ?? []); setError("");
    } catch (reason) { if (!controller.signal.aborted && mounted.current) { setItem(null); setLibrary(null); setError(reason instanceof Error ? reason.message : "This title could not be loaded."); } }
    finally { if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }, [id, itemId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
    setItem(null); setLoading(true); setLibrary(null);
    if (user) void load();
    return () => { request.current?.abort(); };
  }, [id, itemId, user, authLoading, router, load]);
  const [checking, setChecking] = useState(false);
  async function checkAgain() { if (!item) return; setChecking(true); try { await api(`/api/account/library/${encodeURIComponent(item.id)}/check`, { method: "POST", body: "{}" }); await load(); } catch { /* the banner stays; try again later */ } finally { setChecking(false); } }
  const matching = item?.metadataStatus === "queued" || item?.metadataStatus === "processing";
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, attempts = 0;
    const schedule = () => { if (!disposed && matching && attempts < 36 && document.visibilityState === "visible") timer = setTimeout(async () => { attempts++; await load(); schedule(); }, 2500); };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === "visible") { void load(); schedule(); } };
    schedule(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [matching, load]);
  if (authLoading || !user) return <main className={styles.page}><p role="status">Checking your account…</p></main>;
  if (loading && !item) return <main className={styles.page}><p className={styles.loading} role="status">Opening this shared title…</p></main>;
  if (!item) return <main className={styles.page}><Link className={styles.back} href={`/shared-libraries/${encodeURIComponent(id)}`}>← {library?.name ?? "Shared library"}</Link><section className={styles.unavailable}><h1>This title is unavailable.</h1><p>{error || "It may have been removed, or your library access may have changed. Ask the server owner to check."}</p><button type="button" className="btn btn-secondary" onClick={() => void load()}>Try again</button></section></main>;
  const name = accountMediaName(item), metadata = item.metadata, poster = safeMediaUrl(metadata?.posterUrl), backdrop = safeMediaUrl(metadata?.backdropUrl), imdb = imdbLink(metadata?.imdbId), source = metadata ? metadataSourceLink(metadata) : null;
  return <main className={styles.page}>
    <Link className={styles.back} href={`/shared-libraries/${encodeURIComponent(id)}`}>← {library?.name ?? "Shared library"}</Link>
    {error && <p className={styles.error} role="alert">Your last title snapshot is shown. {error}</p>}
    <section className={styles.hero} style={backdrop ? { backgroundImage: `linear-gradient(90deg,var(--bg) 8%,color-mix(in srgb,var(--bg) 78%,transparent)),url("${backdrop.replace(/["\\]/g, "")}")` } : undefined}>
      <div className={styles.poster}><div className={styles.posterFallback} aria-hidden="true"><span>{item.type === "series" ? "SERIES" : "FILM"}</span><strong>{name}</strong><i>{item.year ?? "SERVER COLLECTION"}</i></div>{poster && <img src={poster} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />}</div>
      <div className={styles.heroCopy}><p className={styles.eyebrow}>SHARED BY YOUR SERVER</p><h1>{name}</h1><div className={styles.facts}><span>{item.year ?? metadata?.year ?? "Year unknown"}</span><span>{item.type === "series" ? "Series" : "Movie"}</span>{metadata?.runtimeMinutes != null && <span>{metadata.runtimeMinutes} min</span>}{metadata?.contentRating && <span>{metadata.contentRating}</span>}{metadata?.rating != null && <span>★ {metadata.rating.toFixed(1)} / 10 · {metadata.ratingSource ?? PROVIDER_LABELS[metadata.provider]}</span>}</div>
        {item.tags?.length ? <ul className={styles.tags} aria-label="Video and audio formats">{item.tags.map(tag => <li key={`${tag.kind}-${tag.label}`} className={`${styles.tag} ${tag.kind === "resolution" ? styles.tagResolution : tag.kind === "hdr" ? styles.tagHdr : ""}`} data-kind={tag.kind}>{tag.label}</li>)}</ul> : null}
        {metadata?.genres.length ? <p className={styles.genres}>{metadata.genres.join(" · ")}</p> : null}
        <p className={styles.overview}>{metadata?.description || "This title is part of a collection shared with you by the server. Your server handles the connection when you press Play."}</p>
        <div className={styles.actions}><button type="button" className="btn" aria-label="Play from server" onClick={() => router.push(`/play/${encodeURIComponent(id)}/${encodeURIComponent(item.id)}`)}>▶ Play from server</button><FavoriteToggle libraryId={id} item={item} onChange={favorite => setItem(current => current ? { ...current, favorite } : current)} /><TrailerButton libraryId={id} item={item} /><WatchedToggle libraryId={id} item={item} onChange={watched => setItem(current => current ? { ...current, watched } : current)} /></div>
        {item.type === "series" && versions.length > 1 && versions.some(version => version.season) && <section aria-label="Seasons" className={styles.seasons}>
          <h2>Seasons</h2>
          <ul>{[...versions].sort((a, b) => (a.season?.from ?? 99) - (b.season?.from ?? 99) || (b.createdAt > a.createdAt ? 1 : -1)).map(version => <li key={version.id}>
            <Link href={`/shared-libraries/${encodeURIComponent(id)}/${encodeURIComponent(version.id)}`} aria-current={version.current ? "page" : undefined} className={version.current ? styles.seasonCurrent : undefined}>
              <strong>{version.season ? version.season.from === version.season.to ? `Season ${version.season.from}` : `Seasons ${version.season.from}–${version.season.to}` : "Other"}</strong>
              <span>{version.quality ?? version.release ?? "Version"}{version.phase === "finished" ? "" : ` (${version.phase})`}{version.current ? " · you are here" : ""}</span>
            </Link></li>)}</ul>
        </section>}
        {versions.length > 1 && !(item.type === "series" && versions.some(version => version.season)) && <label className={styles.availability} style={{ display: "block" }}>This title has {versions.length} versions:{" "}<select aria-label="Version" value={item.id} onChange={event => router.push(`/shared-libraries/${encodeURIComponent(id)}/${encodeURIComponent(event.target.value)}`)}>
          {versions.map(version => <option key={version.id} value={version.id}>{version.quality ?? version.release ?? "Version"}{version.phase === "finished" ? "" : ` (${version.phase})`}{version.health === "broken" ? " · link stopped working" : ""} · added {new Date(version.createdAt).toLocaleDateString()}</option>)}
        </select></label>}
        {user?.role === "admin" && <label className={styles.availability} style={{ display: "block" }}>Age rating (administrators only):{" "}<select aria-label="Age rating" value={item.ratingManual ? item.ratingLabel ?? "" : ""} onChange={event => { void api(`/api/admin/shared-libraries/items/${encodeURIComponent(item.id)}/rating`, { method: "PUT", body: JSON.stringify({ rating: event.target.value || null }) }).then(() => load()).catch(reason => setError(reason instanceof Error ? reason.message : "The rating could not be saved.")); }}>
          <option value="">{!item.ratingManual && item.ratingLabel ? `From metadata: ${item.ratingLabel}` : "Not rated: hidden from limited accounts"}</option>
          {["G", "TV-Y", "TV-Y7", "PG", "TV-PG", "PG-13", "TV-14", "R", "TV-MA"].map(label => <option key={label} value={label}>{label}</option>)}
        </select></label>}
        <p className={styles.availability}>Server-managed playback <span>·</span> {item.health === "broken" ? "Link needs attention" : item.phase === "finished" ? "Provider reports ready" : item.phase === "error" ? "Provider entry needs attention" : `${item.phase === "downloading" ? "Downloading" : "Queued"} · ${Math.max(0, Math.min(100, item.progress))}%`}{matching ? " · Metadata matching queued" : item.metadataStatus === "review" ? " · Metadata needs review" : ""}</p>
        {(item.health === "broken" || (user?.role === "admin" && MATCH_TO_FIX[item.metadataStatus ?? ""])) && <div className={styles.attention} role="status">
          {item.health === "broken" && <p><strong>⚠ This link stopped working.</strong> {user?.role === "admin" ? "A replacement was requested automatically; it switches over by itself once one is available." : "The server owner has been asked to replace it."}{user?.role === "admin" && <>{" "}<button type="button" className="btn btn-sm btn-secondary" disabled={checking} onClick={() => void checkAgain()}>{checking ? "Checking…" : "Check again"}</button> <Link href={`/library/${encodeURIComponent(item.id)}`}>Open the import</Link></>}</p>}
          {user?.role === "admin" && MATCH_TO_FIX[item.metadataStatus ?? ""] && <p><strong>⚠ {MATCH_TO_FIX[item.metadataStatus ?? ""]}.</strong> The poster, year and details for this title may be wrong or missing. <Link href={`/library/${encodeURIComponent(item.id)}`}>Fix the match</Link></p>}
        </div>}
      </div>
    </section>
    <section className={styles.details} aria-label="Shared title information"><div><p className={styles.eyebrow}>THE STORY, WITH MORE CONTEXT</p><h2>{metadata?.cast.length ? "Cast" : "Part of your server’s collection"}</h2>{metadata?.cast.length ? <div className={styles.cast}>{metadata.cast.map((person, index) => <span key={`${person}-${index}`}><i aria-hidden="true">{person.split(" ").filter(Boolean).map(part => part[0]).slice(0, 2).join("")}</i>{person}</span>)}</div> : <p className={styles.copy}>The server owner can add artwork, cast and details through automatic metadata matching. You can watch without configuring a personal provider account.</p>}</div><aside className={styles.source}><p className={styles.eyebrow}>WHERE THIS TITLE LIVES</p><h2>Shared collection</h2><dl><div><dt>Playback</dt><dd>Managed by your server</dd></div><div><dt>Library</dt><dd>{library?.name ?? "Shared library"}</dd></div><div><dt>Imported</dt><dd>{Number.isNaN(Date.parse(item.createdAt)) ? "Not recorded" : new Date(item.createdAt).toLocaleDateString()}</dd></div>{metadata && <div><dt>Metadata</dt><dd>{PROVIDER_LABELS[metadata.provider]}</dd></div>}{metadata?.imdbId && <div><dt>IMDb ID</dt><dd>{metadata.imdbId}</dd></div>}</dl><div className={styles.sourceLinks}>{imdb && <a href={imdb} target="_blank" rel="noreferrer">View IMDb ↗</a>}{source && source !== imdb && <a href={source} target="_blank" rel="noreferrer">Metadata source ↗</a>}</div></aside></section>
    {metadata && <footer className={styles.attribution}>{metadata.provider === "tmdb" && <img src="/metadata/tmdb.svg" alt="TMDB" width={94} height={24} />}<p>{metadata.provider === "tmdb" ? "This product uses the TMDB API but is not endorsed or certified by TMDB." : metadata.provider === "free" ? "Metadata from Cinemeta, which serves IMDb-linked data. No account is used." : "IMDb-linked metadata supplied by OMDb."} Metadata and artwork belong to their respective providers and rights holders.</p></footer>}
  </main>;
}
