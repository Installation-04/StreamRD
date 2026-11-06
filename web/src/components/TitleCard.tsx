"use client";

import Link from "next/link";
import { TitleCardData } from "@/lib/types";

interface TitleCardProps {
  title: TitleCardData;
  isFavorite?: boolean;
  favoritePending?: boolean;
  onToggleFavorite?: (title: TitleCardData) => void;
}

export function TitleCard({ title, isFavorite, favoritePending, onToggleFavorite }: TitleCardProps) {
  return (
    <Link href={`/title/${title.id}`} className="title-card">
      {onToggleFavorite && (
        <button
          type="button"
          disabled={favoritePending}
          aria-busy={favoritePending || undefined}
          className={`favorite-toggle${isFavorite ? " is-favorite" : ""}`}
          title={isFavorite ? "Remove from My List" : "Add to My List"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFavorite(title);
          }}
        >
          {isFavorite ? "♥" : "♡"}
        </button>
      )}
      {title.posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="title-poster" src={title.posterUrl} alt={title.name} loading="lazy" />
      ) : (
        <div className="title-poster-fallback">{title.name}</div>
      )}
      {title.positionSeconds !== undefined && title.durationSeconds !== undefined && title.durationSeconds > 0 && <progress aria-label={`${title.name} viewing progress`} value={title.positionSeconds} max={title.durationSeconds} style={{ width: "100%" }} />}
      <div className="title-card-name">
        {title.name}
        {title.year ? <span className="dim"> · {title.year}</span> : null}
      </div>
    </Link>
  );
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
  return (
    <section className="row-section">
      <h2 className="row-label">{label}</h2>
      <div className="row-scroller">
        {titles.map((t) => (
          <TitleCard
            key={t.id}
            title={t}
            isFavorite={favoriteIds?.has(t.id)}
            favoritePending={(knownFavoriteIds !== undefined && !knownFavoriteIds.has(t.id)) || busyFavoriteIds?.has(t.id)}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>
      {onLoadMore && <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={onLoadMore} aria-label={`Load more ${label}`}>{loading ? "Loading…" : "Load more"}</button>}
    </section>
  );
}
