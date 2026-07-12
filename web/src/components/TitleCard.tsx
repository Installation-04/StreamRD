"use client";

import Link from "next/link";
import { Title } from "@/lib/types";

export function TitleCard({ title }: { title: Title }) {
  return (
    <Link href={`/title/${title.id}`} className="title-card">
      {title.posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="title-poster" src={title.posterUrl} alt={title.name} />
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

export function TitleRow({ label, titles }: { label: string; titles: Title[] }) {
  return (
    <section className="row-section">
      <h2 className="row-label">{label}</h2>
      <div className="row-scroller">
        {titles.map((t) => (
          <TitleCard key={t.id} title={t} />
        ))}
      </div>
    </section>
  );
}
