"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMedia } from "@/lib/account-library";
import LibraryCard from "@/components/LibraryCard";
import gallery from "@/app/library/library.module.css";

interface Entry { libraryId: string; item: AccountMedia }

/** The viewer's own list: every title they have hearted, newest first. */
export default function MyListPage() {
  const { user, loading: authLoading } = useAuth();
  const [entries, setEntries] = useState<Entry[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (authLoading || !user) return;
    const controller = new AbortController();
    api<{ items: Entry[] }>("/api/shared-libraries/favorites", { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setEntries(response.items); })
      .catch(() => { if (!controller.signal.aborted) setError("Your list could not be loaded. Check the connection and try again."); });
    return () => controller.abort();
  }, [authLoading, user]);
  return <main id="main-content" className="container">
    <div className="page-heading"><div><p className="eyebrow">YOUR LIST</p><h1>My List</h1><p className="page-description">The titles you saved, ready when you are.</p></div></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {entries === null && !error && <div className={gallery.skeleton} role="status">Gathering your list…</div>}
    {entries?.length === 0 && <section className="collection-empty"><h2>Nothing on your list yet.</h2><p>Use the heart on any title to save it here.</p><div className="feature-actions"><Link href="/shared-libraries" className="btn">Browse libraries</Link></div></section>}
    {entries && entries.length > 0 && <section className={gallery.grid} aria-label="My List">{entries.map(entry => <LibraryCard key={entry.item.id} libraryId={entry.libraryId} item={entry.item} onFavorite={favorite => { if (!favorite) setEntries(list => (list ?? []).filter(row => row.item.id !== entry.item.id)); }} />)}</section>}
  </main>;
}
