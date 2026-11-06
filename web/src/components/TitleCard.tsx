"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { TitleCardData } from "@/lib/types";
import { Icon } from "./Icon";

interface TitleCardProps {
  title: TitleCardData;
  isFavorite?: boolean;
  favoritePending?: boolean;
  onToggleFavorite?: (title: TitleCardData) => void;
}
function paletteFor(name: string) { return Array.from(name).reduce((sum, letter) => (sum * 31 + letter.charCodeAt(0)) % 5, 0); }
export function TitleCard({ title, isFavorite, favoritePending, onToggleFavorite }: TitleCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => { setImageFailed(false); }, [title.posterUrl]);
  const hasProgress = title.positionSeconds !== undefined && title.durationSeconds !== undefined && title.durationSeconds > 0;
  const progress = hasProgress ? Math.min(100, Math.max(0, title.positionSeconds! / title.durationSeconds! * 100)) : 0;
  return <article className="title-card" data-palette={paletteFor(title.name)}>
    <Link href={`/title/${title.id}`} className="title-card-link" aria-label={`View ${title.name}${title.year ? ` (${title.year})` : ""}`}>
      <div className="title-artwork">
        {title.posterUrl && !imageFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="title-poster" src={title.posterUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} />
        ) : <div className="title-poster-fallback"><span className="poster-wordmark">STREAMRD COLLECTION</span><span className="poster-orbit" aria-hidden="true" /><span className="poster-monogram" aria-hidden="true">{title.name.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="poster-fallback-name">{title.name}</span>{title.year && <span className="poster-fallback-year">{title.year}</span>}</div>}
        <span className="title-open-hint" aria-hidden="true"><Icon name="play" size={22} /></span>
      </div>
      {hasProgress && <progress className="title-progress" aria-label={`${title.name} viewing progress`} value={Math.min(title.positionSeconds!, title.durationSeconds!)} max={title.durationSeconds} />}
      <div className="title-card-info"><h3 className="title-card-name">{title.name}</h3><p className="title-card-meta">{title.year || "In your collection"}{hasProgress && <span>{Math.round(progress)}% watched</span>}</p></div>
    </Link>
    {onToggleFavorite && <button type="button" disabled={favoritePending} aria-busy={favoritePending || undefined} aria-pressed={isFavorite === true} aria-label={`${isFavorite ? "Remove" : "Add"} ${title.name} ${isFavorite ? "from" : "to"} My List`} className={`favorite-toggle${isFavorite ? " is-favorite" : ""}`} title={isFavorite ? "Remove from My List" : "Add to My List"} onClick={() => onToggleFavorite(title)}><Icon name={isFavorite ? "heart" : "plus"} size={17} /></button>}
  </article>;
}
interface TitleRowProps {
  label: string;
  onLoadMore?: () => void;
  loading?: boolean;
  titles: TitleCardData[];
  favoriteIds?: Set<string>;
  knownFavoriteIds?: Set<string>;
  busyFavoriteIds?: Set<string>;
  onToggleFavorite?: (title: TitleCardData) => void;
}
export function TitleRow({ label, titles, favoriteIds, knownFavoriteIds, busyFavoriteIds, onToggleFavorite, onLoadMore, loading }: TitleRowProps) {
  const headingId = useId(), scroller = useRef<HTMLDivElement>(null);
  function scroll(direction: number) {
    const element = scroller.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  return <section className="row-section" aria-labelledby={headingId}>
    <div className="row-heading"><div><h2 className="row-label" id={headingId}>{label}</h2><p className="row-caption">{titles.length} {titles.length === 1 ? "title" : "titles"}{onLoadMore ? " loaded" : " to explore"}</p></div><div className="row-actions">{onLoadMore && <button type="button" className="text-button" disabled={loading} onClick={onLoadMore} aria-label={`Load more ${label}`}>{loading ? "Loading…" : "Load more"}<Icon name="plus" size={15} /></button>}{titles.length > 1 && <><button type="button" className="icon-button row-scroll-back" aria-label={`Scroll ${label} left`} onClick={() => scroll(-1)}><Icon name="chevron" size={15} /></button><button type="button" className="icon-button" aria-label={`Scroll ${label} right`} onClick={() => scroll(1)}><Icon name="chevron" size={15} /></button></>}</div></div>
    <div className="row-scroller" ref={scroller} aria-busy={loading || undefined}>
      {titles.map(title => <TitleCard key={title.id} title={title} isFavorite={favoriteIds?.has(title.id)} favoritePending={(knownFavoriteIds !== undefined && !knownFavoriteIds.has(title.id)) || busyFavoriteIds?.has(title.id)} onToggleFavorite={onToggleFavorite} />)}
      {onLoadMore && <button type="button" className="more-card" disabled={loading} onClick={onLoadMore} aria-label={`Load more ${label}`}><span><Icon name="plus" size={22} /></span>{loading ? "Loading…" : "Keep exploring"}</button>}
    </div>
  </section>;
}
