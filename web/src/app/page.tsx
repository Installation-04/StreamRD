"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api, del, post } from "@/lib/api";
import { t } from "@/lib/i18n";
import { BrowsePage, BrowseRow, TitleCardData } from "@/lib/types";
import { TitleRow } from "@/components/TitleCard";
import { PlaybackProfile } from "@/components/PlaybackProfile";
import { usePlaybackProfile } from "@/lib/usePlaybackProfile";
import { useRouter } from "next/navigation";

type ListPage = { titles: TitleCardData[]; nextCursor: string | null };
type PersonalList = "favorites" | "history";
const emptyPage: ListPage = { titles: [], nextCursor: null };
const listPath = (list: PersonalList, profileId?: string | null) => list === "favorites" ? "/api/account/favorites/page" : `/api/play/continue${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ""}`;
const appendTitles = (old: TitleCardData[], added: TitleCardData[]) => [...old, ...added.filter(title => !old.some(existing => existing.id === title.id))];

export default function HomePage() {
  const profile = usePlaybackProfile();
  const [rows, setRows] = useState<BrowseRow[] | null>(null);
  const [favorites, setFavorites] = useState<ListPage>(emptyPage);
  const [history, setHistory] = useState<ListPage>(emptyPage);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [knownFavorites, setKnownFavorites] = useState<Set<string>>(new Set());
  const [favoriteBusy, setFavoriteBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [nextGenre, setNextGenre] = useState<string | null>(null);
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const router = useRouter();
  const active = useRef(new Set<string>());
  const requests = useRef(new Set<AbortController>());
  const favoriteLocks = useRef(new Set<string>());
  // In-flight status/page responses must not undo a user's optimistic edit.
  const favoriteOverrides = useRef(new Map<string, boolean>());

  function rememberFavorites(titles: TitleCardData[]) {
    setFavIds(prev => {
      const next = new Set(prev);
      for (const title of titles) if (favoriteOverrides.current.get(title.id) !== false) next.add(title.id);
      return next;
    });
    setKnownFavorites(prev => new Set([...prev, ...titles.map(title => title.id)]));
  }

  async function loadFavoriteStatus(titles: TitleCardData[], signal: AbortSignal) {
    const ids = [...new Set(titles.map(title => title.id))];
    if (!ids.length) return;
    try {
      const page = await api<{ favoriteIds: string[] }>("/api/account/favorites/status", {
        method: "POST", body: JSON.stringify({ titleIds: ids }), signal,
      });
      if (signal.aborted) return;
      const saved = new Set(page.favoriteIds);
      setFavIds(prev => {
        const next = new Set(prev);
        for (const id of ids) {
          if (favoriteOverrides.current.has(id)) continue;
          if (saved.has(id)) next.add(id); else next.delete(id);
        }
        return next;
      });
      setKnownFavorites(prev => new Set([...prev, ...ids]));
    } catch (err) {
      if (!signal.aborted && !(err instanceof ApiError && err.status === 401)) setError("Could not load saved-title status. Refresh to retry.");
    }
  }

  useEffect(() => {
    if (!profile.ready) return;
    setHistory(emptyPage);
    setLoading(new Set());
    const controller = new AbortController();
    const { signal } = controller;
    api<BrowsePage>("/api/catalog/browse", { signal })
      .then(page => {
        if (signal.aborted) return;
        setRows(page.rows); setNextGenre(page.nextGenre);
        void loadFavoriteStatus(page.rows.flatMap(row => row.titles), signal);
      })
      .catch((err: ApiError) => {
        if (signal.aborted) return;
        if (err.status === 401) router.push("/login"); else setError(err.message);
      });
    api<ListPage>(listPath("favorites"), { signal }).then(page => {
      if (signal.aborted) return;
      setFavorites({ ...page, titles: page.titles.filter(title => favoriteOverrides.current.get(title.id) !== false) });
      rememberFavorites(page.titles);
    }).catch(err => { if (!signal.aborted && !(err instanceof ApiError && err.status === 401)) setError("Could not load My List. Refresh to retry."); });
    api<ListPage>(listPath("history", profile.profileId), { signal }).then(page => {
      if (signal.aborted) return;
      setHistory(page); void loadFavoriteStatus(page.titles, signal);
    }).catch(err => { if (!signal.aborted && !(err instanceof ApiError && err.status === 401)) setError("Could not load viewing history. Refresh to retry."); });
    return () => {
      controller.abort();
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, [router, profile.ready, profile.profileId]);

  async function loadMore(row?: BrowseRow, list?: PersonalList) {
    const key = list ? `list:${list}` : row?.id ?? "more-genres";
    if (active.current.has(key)) return;
    const cursor = list ? (list === "favorites" ? favorites : history).nextCursor : row ? row.nextCursor : nextGenre;
    if (!cursor) return;
    active.current.add(key); setLoading(prev => new Set(prev).add(key));
    const controller = new AbortController();
    requests.current.add(controller); setError(null);
    try {
      if (list) {
        const page = await api<ListPage>(`${listPath(list, profile.profileId)}${list === "history" && profile.profileId ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (list === "favorites") {
          setFavorites(prev => ({ ...page, titles: appendTitles(prev.titles, page.titles.filter(title => favoriteOverrides.current.get(title.id) !== false)) }));
          rememberFavorites(page.titles);
        } else {
          setHistory(prev => ({ ...page, titles: appendTitles(prev.titles, page.titles) }));
          await loadFavoriteStatus(page.titles, controller.signal);
        }
      } else if (row) {
        const page = await api<BrowseRow>(`/api/catalog/browse/row?row=${encodeURIComponent(row.id)}&cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRows(prev => prev?.map(existing => existing.id === row.id ? { ...page, titles: appendTitles(existing.titles, page.titles) } : existing) ?? null);
        await loadFavoriteStatus(page.titles, controller.signal);
      } else {
        const page = await api<BrowsePage>(`/api/catalog/browse?afterGenre=${encodeURIComponent(cursor)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRows(prev => [...(prev ?? []), ...page.rows.filter(row => !prev?.some(old => old.id === row.id))]);
        setNextGenre(page.nextGenre);
        await loadFavoriteStatus(page.rows.flatMap(row => row.titles), controller.signal);
      }
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally {
      requests.current.delete(controller); active.current.delete(key);
      if (!controller.signal.aborted) setLoading(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }

  async function toggleFavorite(title: TitleCardData) {
    if (favoriteLocks.current.has(title.id) || !knownFavorites.has(title.id)) return;
    const wasFavorite = favIds.has(title.id);
    favoriteLocks.current.add(title.id);
    setFavoriteBusy(prev => new Set(prev).add(title.id));
    favoriteOverrides.current.set(title.id, !wasFavorite);
    function showFavorite(saved: boolean) {
      setFavIds(prev => { const next = new Set(prev); if (saved) next.add(title.id); else next.delete(title.id); return next; });
      setFavorites(prev => ({ ...prev, titles: saved ? [title, ...prev.titles.filter(old => old.id !== title.id)] : prev.titles.filter(old => old.id !== title.id) }));
    }
    showFavorite(!wasFavorite);
    try {
      if (wasFavorite) await del(`/api/account/favorites/${title.id}`); else await post(`/api/account/favorites/${title.id}`);
    } catch {
      favoriteOverrides.current.set(title.id, wasFavorite); showFavorite(wasFavorite);
      setError("Could not update My List. Please try again.");
    } finally {
      favoriteLocks.current.delete(title.id);
      setFavoriteBusy(prev => { const next = new Set(prev); next.delete(title.id); return next; });
    }
  }

  const favoriteProps = { favoriteIds: favIds, knownFavoriteIds: knownFavorites, busyFavoriteIds: favoriteBusy, onToggleFavorite: toggleFavorite };
  return (
    <main className="container">
      <PlaybackProfile {...profile} onChange={profile.chooseProfile} />
      {profile.error && <p role="alert" className="error-text">{profile.error}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {rows && rows.length === 0 && favorites.titles.length === 0 && history.titles.length === 0 && <p className="dim" style={{ marginTop: 40 }}>{t("home.empty")}</p>}
      {history.titles.length > 0 && <TitleRow label={t("home.continueWatching")} titles={history.titles} {...favoriteProps} loading={loading.has("list:history")} onLoadMore={history.nextCursor ? () => void loadMore(undefined, "history") : undefined} />}
      {(favorites.titles.length > 0 || favorites.nextCursor) && <TitleRow label={t("home.myList")} titles={favorites.titles} {...favoriteProps} loading={loading.has("list:favorites")} onLoadMore={favorites.nextCursor ? () => void loadMore(undefined, "favorites") : undefined} />}
      {rows?.map(row => <TitleRow key={row.id} label={row.label} titles={row.titles} {...favoriteProps} onLoadMore={row.nextCursor ? () => void loadMore(row) : undefined} loading={loading.has(row.id)} />)}
      {nextGenre && <button type="button" className="btn btn-secondary" disabled={loading.has("more-genres")} onClick={() => void loadMore()}>{loading.has("more-genres") ? "Loading…" : "More genres"}</button>}
    </main>
  );
}
