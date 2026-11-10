"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { accountMediaName, safeMediaUrl } from "@/lib/account-library";
import { ExternalCard, HomeData, LibraryCard } from "@/lib/home";
import { SharedContinueItem } from "@/lib/shared-libraries";
import styles from "./HomeSections.module.css";

type Tile = { key: string; href: string; name: string; sub: string; poster: string | null; kind: string; progress?: number };
const libraryTile = ({ libraryId, item }: LibraryCard): Tile => ({
  key: `${libraryId ?? "own"}/${item.id}`, href: libraryId ? `/shared-libraries/${encodeURIComponent(libraryId)}/${encodeURIComponent(item.id)}` : `/library/${encodeURIComponent(item.id)}`, name: accountMediaName(item),
  sub: [item.year ?? item.metadata?.year, item.type === "series" ? "TV show" : "Movie"].filter(Boolean).join(" · "), poster: safeMediaUrl(item.metadata?.posterUrl), kind: item.type === "series" ? "SERIES" : "FILM",
});
const externalTile = (card: ExternalCard): Tile => ({
  key: `${card.type}/${card.id}`, href: `/discover/free/${card.type}/${encodeURIComponent(card.id)}`, name: card.name,
  sub: [card.year, card.rating ? `★ ${card.rating.toFixed(1)}` : null].filter(Boolean).join(" · "), poster: safeMediaUrl(card.posterUrl), kind: card.type === "series" ? "SERIES" : "FILM",
});

function Row({ title, note, tiles, label }: { title: string; note?: string; tiles: Tile[]; label: string }) {
  if (!tiles.length) return null;
  return <section className={styles.section} aria-label={title}>
    <div className={styles.head}><h2>{title}</h2>{note && <span>{note}</span>}</div>
    <div className={styles.row}>{tiles.map(tile => <Link key={tile.key} href={tile.href} className={styles.card} aria-label={`${label} ${tile.name}`}>
      <div className={styles.poster}><div className={styles.fallback} aria-hidden="true"><i>{tile.kind}</i>{tile.name}</div>{tile.poster && <img src={tile.poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = "none"; }} />}
        {tile.progress !== undefined && <progress className={styles.progress} max={100} value={tile.progress} aria-label={`${Math.round(tile.progress)}% watched`} />}</div>
      <p className={styles.name}>{tile.name}</p>{tile.sub && <p className={styles.sub}>{tile.sub}</p>}
    </Link>)}</div>
  </section>;
}

/** Plex-style rows: what the viewer can watch (continue, recently added, popular here) and what the world is watching (trending, popular). */
export default function HomeSections({ onLoaded }: { onLoaded?: (libraryTitles: number) => void }) {
  const [home, setHome] = useState<HomeData | null>(null), [resume, setResume] = useState<SharedContinueItem[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api<HomeData>("/api/home", { signal: controller.signal }).then(data => { if (!controller.signal.aborted) { setHome(data); onLoaded?.(data.recentlyAdded.length); } })
      .catch(() => { if (!controller.signal.aborted) onLoaded?.(0); });
    api<{ items: SharedContinueItem[] }>("/api/shared-libraries/continue?limit=12", { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setResume(data.items); }).catch(() => {});
    return () => controller.abort();
  }, [onLoaded]);
  const continueTiles = resume.map((entry): Tile => ({ ...libraryTile({ libraryId: entry.libraryId, item: entry.item }), progress: entry.durationSeconds > 0 ? Math.max(2, Math.min(98, entry.positionSeconds / entry.durationSeconds * 100)) : undefined }));
  if (!home && !continueTiles.length) return null;
  return <div className={styles.sections}>
    <Row title="Continue watching" tiles={continueTiles} label="Resume" />
    <Row title="Recently added" note="Newest on this server" tiles={(home?.recentlyAdded ?? []).map(libraryTile)} label="Open" />
    <Row title="Popular on this server" note="Most watched in the last 30 days" tiles={(home?.popularHere ?? []).map(libraryTile)} label="Open" />
    <Row title="Trending now" note="Across movies and TV shows" tiles={(home?.trending ?? []).map(externalTile)} label="See" />
    <Row title="Popular movies" tiles={(home?.popularMovies ?? []).map(externalTile)} label="See" />
    <Row title="Popular TV shows" tiles={(home?.popularSeries ?? []).map(externalTile)} label="See" />
    {home?.externalEnabled && (home.trending.length > 0 || home.popularMovies.length > 0) && <p className={styles.credit}>Trending and popular lists come from Cinemeta (IMDb-linked data). Open a title to request it.</p>}
  </div>;
}
