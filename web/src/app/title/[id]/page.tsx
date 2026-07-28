"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { del, get, post } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Title } from "@/lib/types";

export default function TitleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [title, setTitle] = useState<Title | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFavorite, setIsFavorite] = useState(false);

  useEffect(() => {
    get<{ title: Title }>(`/api/catalog/title/${id}`)
      .then((res) => setTitle(res.title))
      .catch((err: Error) => setError(err.message));
    get<{ titles: Title[] }>("/api/account/favorites")
      .then((res) => setIsFavorite(res.titles.some((fav) => fav.id === id)))
      .catch(() => {});
  }, [id]);

  async function toggleFavorite() {
    const next = !isFavorite;
    setIsFavorite(next);
    try {
      if (next) await post(`/api/account/favorites/${id}`);
      else await del(`/api/account/favorites/${id}`);
    } catch {
      setIsFavorite(!next);
    }
  }

  if (error) return <main className="container"><p className="error-text">{error}</p></main>;
  if (!title) return <main className="container"><p className="dim" style={{ marginTop: 40 }}>Loading…</p></main>;

  return (
    <main className="container">
      <div
        className="hero"
        style={
          title.backdropUrl
            ? {
                backgroundImage: `linear-gradient(90deg, rgba(0,0,0,0.85) 30%, rgba(0,0,0,0.3)), url(${title.backdropUrl})`,
              }
            : undefined
        }
      >
        <div className="hero-inner">
          <h1 style={{ fontSize: 36, marginBottom: 10 }}>{title.name}</h1>
          <p style={{ marginBottom: 14 }}>
            {title.year && <span className="badge">{title.year}</span>}
            <span className="badge">{title.type}</span>
            {title.genres.map((g) => (
              <span key={g} className="badge">{g}</span>
            ))}
            <span className="badge">
              {title.sourceCount} {t("title.sources")}
            </span>
          </p>
          <p className="dim" style={{ marginBottom: 22, lineHeight: 1.6 }}>{title.description}</p>
          <Link href={`/watch/${title.id}`} className="btn" style={{ display: "inline-block", marginRight: 10 }}>
            ▶ {t("title.play")}
          </Link>
          <button
            type="button"
            className={`favorite-toggle-large${isFavorite ? " is-favorite" : ""}`}
            onClick={toggleFavorite}
          >
            {isFavorite ? "♥" : "♡"} {isFavorite ? t("title.removeFromList") : t("title.addToList")}
          </button>
        </div>
      </div>
    </main>
  );
}
