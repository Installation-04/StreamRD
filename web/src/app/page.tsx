"use client";

import HomeSections from "@/components/HomeSections";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/Icon";
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
  const { user } = useAuth();
  const [view, setView] = useState("all");
  const [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<BrowseRow[] | null>(null);
  const [favorites, setFavorites] = useState<ListPage>(emptyPage);
  const [history, setHistory] = useState<ListPage>(emptyPage);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [knownFavorites, setKnownFavorites] = useState<Set<string>>(new Set());
  const [favoriteBusy, setFavoriteBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [libraryTotal, setLibraryTotal] = useState<number | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const onHomeLoaded = useCallback((titles: number, slides: number) => { setLibraryTotal(titles); setSlideCount(slides); }, []);
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
    setRows(null);
    setError(null);
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
  }, [router, profile.ready, profile.profileId, refresh]);

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
  const featured = history.titles[0] ?? rows?.find(row => row.id === "recent")?.titles[0];
  const hasCollection = Boolean(rows?.some(row => row.titles.length) || favorites.titles.length || history.titles.length);
  const filters = [{ id: "all", label: "For you", icon: "grid" as const }, { id: "movies", label: "Movies", icon: "film" as const }, { id: "series", label: "Series", icon: "screen" as const }, { id: "my-list", label: "My List", icon: "heart" as const }];
  const visibleRows = rows?.filter(row => view === "all" || row.id === view);
  const collectionIsEmpty = rows !== null && !hasCollection && (!user || libraryTotal === 0);
  return (
    <main className="container home-page">
      <div className="page-heading">
        <div><p className="eyebrow">YOUR PERSONAL CINEMA</p><h1>{user ? `Welcome back${user.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}.` : "Make room for a good story."}</h1><p className="page-description">A collection that feels like yours. Pick up a favorite or find your next watch.</p></div>
        <PlaybackProfile {...profile} onChange={profile.chooseProfile} />
      </div>
      {profile.error && <p role="alert" className="error-banner">{profile.error}</p>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => setRefresh(value => value + 1)}>Try again<Icon name="arrow" size={15} /></button></div>}
      {rows === null && !error && <div className="catalog-skeleton" role="status" aria-label="Loading your collection"><span className="skeleton skeleton-hero" /><div className="skeleton-row">{Array.from({ length: 6 }, (_, i) => <span key={i} className="skeleton skeleton-card" />)}</div><span className="sr-only">Loading your collection…</span></div>}
      {featured && rows !== null && slideCount === 0 && <section className="discovery-hero" aria-label="Featured from your collection">
        <div className="discovery-hero-copy"><span className="feature-kicker"><span />{history.titles[0]?.id === featured.id ? "READY WHEN YOU ARE" : "FROM YOUR COLLECTION"}</span><h2>{featured.name}</h2><div className="feature-meta">{featured.year && <span>{featured.year}</span>}<span>{history.titles[0]?.id === featured.id ? "Continue your story" : "Something worth settling in for"}</span></div><p>{history.titles[0]?.id === featured.id ? "Your place is saved. Return to the story, on your own schedule." : "Your next movie night starts with a title you chose. Take a closer look and make it a good one."}</p><div className="feature-actions"><Link href={`/title/${featured.id}`} className="btn"><Icon name="play" size={18} />{history.titles[0]?.id === featured.id ? "Continue watching" : "Explore title"}</Link><Link href="/search" className="btn btn-secondary"><Icon name="search" size={17} />Find a title</Link></div></div>
        <div className="discovery-hero-art" aria-hidden="true">{featured.posterUrl ? <img src={featured.posterUrl} alt="" onError={event => { event.currentTarget.style.display = "none"; }} /> : <><span className="feature-orbit feature-orbit-one" /><span className="feature-orbit feature-orbit-two" /><span className="feature-monogram">{featured.name.trim().slice(0, 1)}</span><Icon name="play" size={32} /></>}</div>
        <span className="feature-corner-label">YOUR SCREEN. YOUR STORY.</span>
      </section>}
      {user && view === "all" && <HomeSections onLoaded={onHomeLoaded} />}
      {collectionIsEmpty && <section className="collection-empty"><span className="empty-icon"><Icon name="film" size={28} /></span><p className="eyebrow">THE FIRST SCENE IS YOURS</p><h2>Let’s build your collection.</h2><p>{user?.role === "admin" ? "Connect a debrid service, add the titles you love, and make this space your own." : "Your collection is waiting for its first titles. Connect a debrid service while your administrator gets things ready."}</p><div className="feature-actions"><Link href="/setup" className="btn">Get started<Icon name="arrow" size={18} /></Link>{user?.role === "admin" && <Link href="/admin/catalog" className="btn btn-secondary"><Icon name="plus" size={18} />Add a title</Link>}</div><div className="empty-steps"><span><b>01</b> Connect your service</span><span><b>02</b> Curate your collection</span><span><b>03</b> Settle in & watch</span></div></section>}
      {hasCollection && <>
        <div className="collection-toolbar"><div className="collection-filters" role="group" aria-label="Browse collection">{filters.map(filter => <button key={filter.id} type="button" className={view === filter.id ? "collection-filter active" : "collection-filter"} aria-pressed={view === filter.id} onClick={() => setView(filter.id)}><Icon name={filter.icon} size={16} />{filter.label}</button>)}</div><Link href="/setup" className="collection-help">Make it yours<Icon name="arrow" size={14} /></Link></div>
        {view === "all" && history.titles.length > 0 && <TitleRow label={t("home.continueWatching")} titles={history.titles} {...favoriteProps} loading={loading.has("list:history")} onLoadMore={history.nextCursor ? () => void loadMore(undefined, "history") : undefined} />}
        {(view === "all" || view === "my-list") && (favorites.titles.length > 0 || favorites.nextCursor) && <TitleRow label={t("home.myList")} titles={favorites.titles} {...favoriteProps} loading={loading.has("list:favorites")} onLoadMore={favorites.nextCursor ? () => void loadMore(undefined, "favorites") : undefined} />}
        {view === "my-list" && !favorites.titles.length && !favorites.nextCursor && <div className="view-empty"><Icon name="heart" size={28} /><h2>Keep the good ones close.</h2><p>Add a title to My List using the + button on any card. Your saved titles will appear here.</p><button className="btn btn-secondary" onClick={() => setView("all")}>Explore your collection</button></div>}
        {visibleRows?.map(row => <TitleRow key={row.id} label={row.label} titles={row.titles} {...favoriteProps} onLoadMore={row.nextCursor ? () => void loadMore(row) : undefined} loading={loading.has(row.id)} />)}
        {(view === "movies" || view === "series") && !visibleRows?.length && rows !== null && <div className="view-empty"><Icon name={view === "movies" ? "film" : "screen"} size={28} /><h2>No {view} in your collection yet.</h2><p>{user?.role === "admin" ? "Add a title in the catalog to give it a home here." : "Your administrator can add titles to this collection."}</p>{user?.role === "admin" && <Link href="/admin/catalog" className="btn btn-secondary">Open catalog<Icon name="arrow" size={16} /></Link>}</div>}
        {view === "all" && nextGenre && <div className="more-genres"><button type="button" className="btn btn-secondary" disabled={loading.has("more-genres")} onClick={() => void loadMore()}>{loading.has("more-genres") ? "Loading…" : "Explore more genres"}<Icon name="plus" size={17} /></button></div>}
      </>}
      <footer className="collection-footer"><span className="footer-brand">streamrd<span> / </span>Your screen. Your story.</span><div><Link href="/setup">Getting started</Link><a href="https://github.com/Installation-04/StreamRD/wiki" target="_blank" rel="noreferrer">Community guide<Icon name="arrow" size={13} /></a></div></footer>
    </main>
  );
}
