"use client";

import { useEffect, useState } from "react";
import { ApiError, del, get, post } from "@/lib/api";
import { t } from "@/lib/i18n";
import { CatalogRow, Title } from "@/lib/types";
import { TitleRow } from "@/components/TitleCard";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [favTitles, setFavTitles] = useState<Title[]>([]);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [continueWatching, setContinueWatching] = useState<Title[]>([]);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    get<{ rows: CatalogRow[] }>("/api/catalog/rows")
      .then((res) => setRows(res.rows))
      .catch((err: ApiError) => {
        if (err.status === 401) router.push("/login");
        else setError(err.message);
      });
    get<{ titles: Title[] }>("/api/account/favorites")
      .then((res) => {
        setFavTitles(res.titles);
        setFavIds(new Set(res.titles.map((title) => title.id)));
      })
      .catch(() => {
        // Not logged in yet, or favorites unavailable — home page still works without it.
      });
    get<{ titles: Title[] }>("/api/account/continue-watching")
      .then((res) => setContinueWatching(res.titles))
      .catch(() => {});
  }, [router]);

  async function toggleFavorite(title: Title) {
    const wasFavorite = favIds.has(title.id);
    setFavIds((prev) => {
      const next = new Set(prev);
      if (wasFavorite) next.delete(title.id);
      else next.add(title.id);
      return next;
    });
    setFavTitles((prev) =>
      wasFavorite ? prev.filter((x) => x.id !== title.id) : [title, ...prev]
    );
    try {
      if (wasFavorite) await del(`/api/account/favorites/${title.id}`);
      else await post(`/api/account/favorites/${title.id}`);
    } catch {
      setFavIds((prev) => {
        const next = new Set(prev);
        if (wasFavorite) next.add(title.id);
        else next.delete(title.id);
        return next;
      });
      setFavTitles((prev) =>
        wasFavorite ? [title, ...prev] : prev.filter((x) => x.id !== title.id)
      );
    }
  }

  return (
    <main className="container">
      {error && <p className="error-text">{error}</p>}
      {rows && rows.length === 0 && favTitles.length === 0 && continueWatching.length === 0 && (
        <p className="dim" style={{ marginTop: 40 }}>{t("home.empty")}</p>
      )}
      {continueWatching.length > 0 && (
        <TitleRow
          label={t("home.continueWatching")}
          titles={continueWatching}
          favoriteIds={favIds}
          onToggleFavorite={toggleFavorite}
        />
      )}
      {favTitles.length > 0 && (
        <TitleRow
          label={t("home.myList")}
          titles={favTitles}
          favoriteIds={favIds}
          onToggleFavorite={toggleFavorite}
        />
      )}
      {rows?.map((row) => (
        <TitleRow
          key={row.id}
          label={row.label}
          titles={row.titles}
          favoriteIds={favIds}
          onToggleFavorite={toggleFavorite}
        />
      ))}
    </main>
  );
}
