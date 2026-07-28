"use client";

import Link from "next/link";
import { Title } from "@/lib/types";

interface TitleCardProps {
  title: Title;
  isFavorite?: boolean;
  onToggleFavorite?: (title: Title) => void;
}

export function TitleCard({ title, isFavorite, onToggleFavorite }: TitleCardProps) {
  return (
    <Link href={`/title/${title.id}`} className="title-card">
      {onToggleFavorite && (
        <button
          type="button"
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
      <div className="title-card-name">
        {title.name}
        {title.year ? <span className="dim"> · {title.year}</span> : null}
      </div>
    </Link>
  );
}

interface TitleRowProps {
  label: string;
  titles: Title[];
  favoriteIds?: Set<string>;
  onToggleFavorite?: (title: Title) => void;
}

export function TitleRow({ label, titles, favoriteIds, onToggleFavorite }: TitleRowProps) {
  return (
    <section className="row-section">
      <h2 className="row-label">{label}</h2>
      <div className="row-scroller">
        {titles.map((t) => (
          <TitleCard
            key={t.id}
            title={t}
            isFavorite={favoriteIds?.has(t.id)}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>
    </section>
  );
}
