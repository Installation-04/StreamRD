"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, del, post } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Title } from "@/lib/types";
import { imdbLink, metadataSourceLink, PROVIDER_LABELS } from "@/lib/metadata";
import styles from "./title.module.css";

export default function TitleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [title, setTitle] = useState<Title | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState("");
  const [isFavorite, setIsFavorite] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const activeId = useRef(id);
  useEffect(() => {
    activeId.current = id;
    const controller = new AbortController();
    setTitle(null); setError(null); setIsFavorite(false); setFavoriteBusy(false); setFavoriteError("");
    void api<{ title: Title }>(`/api/catalog/title/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setTitle(response.title); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This title could not be loaded."); });
    void api<{ titles: Title[] }>("/api/account/favorites", { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setIsFavorite(response.titles.some(favorite => favorite.id === id)); }).catch(() => {});
    return () => controller.abort();
  }, [id]);
  async function toggleFavorite() {
    if (favoriteBusy) return;
    const next = !isFavorite, titleId = id;
    setFavoriteBusy(true); setFavoriteError(""); setIsFavorite(next);
    try { if (next) await post(`/api/account/favorites/${encodeURIComponent(titleId)}`); else await del(`/api/account/favorites/${encodeURIComponent(titleId)}`); }
    catch { if (activeId.current === titleId) { setIsFavorite(!next); setFavoriteError("Your list could not be updated. Try again."); } }
    finally { if (activeId.current === titleId) setFavoriteBusy(false); }
  }
  if (error) return <main className="container"><p className="error-text" role="alert">{error}</p></main>;
  if (!title) return <main className="container"><p className="dim" style={{ marginTop: 40 }} role="status">Loading…</p></main>;
  const metadata = title.metadata;
  const imdb = imdbLink(metadata?.imdbId);
  const source = metadata ? metadataSourceLink(metadata) : null;
  return <main className={`${styles.page} container`}>
    <section className={styles.hero} style={title.backdropUrl ? { backgroundImage: `linear-gradient(90deg, rgba(0,0,0,.9) 10%, rgba(0,0,0,.5) 70%), url(${JSON.stringify(title.backdropUrl)})` } : undefined}>
      <div className={styles.poster}>{title.posterUrl ? <img src={title.posterUrl} alt={`${title.name} poster`} referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = "hidden"; }} /> : <span aria-hidden="true">{title.name.charAt(0)}</span>}</div>
      <div className={styles.heroContent}><p className={styles.eyebrow}>YOUR COLLECTION / {title.type === "series" ? "SERIES" : "MOVIE"}</p><h1>{title.name}</h1>
        <div className={styles.facts}>{title.year && <span>{title.year}</span>}{metadata?.contentRating && <span className={styles.certification}>{metadata.contentRating}</span>}{metadata?.runtimeMinutes != null && metadata.runtimeMinutes > 0 && <span>{metadata.runtimeMinutes} min</span>}{metadata?.rating != null && <span className={styles.rating}>★ {metadata.rating.toFixed(1)}<small>/10{metadata.ratingSource ? ` · ${metadata.ratingSource}` : ""}</small></span>}</div>
        <div className={styles.genres}>{title.genres.map((genre, index) => <span key={`${genre}-${index}`}>{genre}</span>)}</div>
        <p className={styles.overview}>{title.description || "An overview has not been added for this title yet."}</p>
        <div className={styles.actions}><Link href={`/watch/${title.id}`} className="btn">▶ {t("title.play")}</Link><button type="button" disabled={favoriteBusy} className={`favorite-toggle-large${isFavorite ? " is-favorite" : ""}`} onClick={toggleFavorite}>{isFavorite ? "♥" : "♡"} {isFavorite ? t("title.removeFromList") : t("title.addToList")}</button></div>
        {favoriteError && <p className={styles.actionError} role="alert">{favoriteError}</p>}
        <p className={styles.availability}>{title.sourceCount} {t("title.sources")} configured for playback</p>
      </div>
    </section>
    {metadata && <section className={styles.details} aria-label="Movie and series metadata">
      {metadata.cast.length > 0 && <div className={styles.cast}><p className={styles.sectionLabel}>THE PEOPLE BEHIND THE STORY</p><h2>Cast</h2><div className={styles.castList}>{metadata.cast.map((name, index) => <span key={`${name}-${index}`}><i aria-hidden="true">{name.split(" ").filter(Boolean).map(part => part[0]).slice(0, 2).join("")}</i>{name}</span>)}</div></div>}
      <aside className={styles.source}><p className={styles.sectionLabel}>ABOUT THIS MATCH</p><h2>Title information</h2><dl><div><dt>Metadata provider</dt><dd>{PROVIDER_LABELS[metadata.provider]}</dd></div>{metadata.imdbId && <div><dt>IMDb ID</dt><dd>{metadata.imdbId}</dd></div>}{metadata.tmdbId && <div><dt>TMDB ID</dt><dd>{metadata.tmdbId}</dd></div>}<div><dt>Updated</dt><dd>{Number.isNaN(Date.parse(metadata.fetchedAt)) ? "Not recorded" : new Date(metadata.fetchedAt).toLocaleDateString()}</dd></div></dl><div className={styles.sourceLinks}>{imdb && <a href={imdb} target="_blank" rel="noreferrer">View on IMDb ↗</a>}{source && source !== imdb && <a href={source} target="_blank" rel="noreferrer">View metadata source ↗</a>}</div><p>Playback availability depends on the sources configured for this title.</p></aside>
    </section>}
    {metadata && <footer className={styles.attribution}>{metadata.provider === "tmdb" && <img src="/metadata/tmdb.svg" alt="TMDB" width={94} height={24} />}<p>{metadata.provider === "tmdb" ? "This product uses the TMDB API but is not endorsed or certified by TMDB." : "IMDb-linked metadata supplied by OMDb."} Metadata and artwork belong to their respective providers and rights holders.</p></footer>}
  </main>;
}
