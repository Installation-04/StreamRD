"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Title } from "@/lib/types";
import { TitleCard } from "@/components/TitleCard";
import { Icon } from "@/components/Icon";
export default function SearchPage() {
  const [q, setQ] = useState(""), [results, setResults] = useState<Title[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const query = q.trim(), controller = new AbortController();
    if (!query) { setResults([]); setLoading(false); setError(""); return; }
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      api<{ results: Title[] }>(`/api/catalog/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(page => { if (!controller.signal.aborted) setResults(page.results); })
        .catch(err => { if (!controller.signal.aborted) { setError((err as Error).message); setResults([]); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q]);
  return <main className="container home-page">
    <header className="page-heading"><div><p className="eyebrow">A GOOD STORY IS CLOSER THAN YOU THINK</p><h1>Find something for tonight.</h1><p className="page-description">Search the titles in your community’s collection.</p></div><Link href="/" className="btn btn-secondary">Back to discover</Link></header>
    <label className="catalog-search"><Icon name="search" size={24} /><span className="sr-only">Search your collection</span><input type="search" maxLength={500} placeholder="A title, a memory, a movie night…" value={q} onChange={event => setQ(event.target.value)} /></label>
    {error && <p className="error-banner" role="alert">Could not search the collection: {error}</p>}
    {loading && <p role="status" className="page-description">Searching your collection…</p>}
    {!loading && q.trim() && !error && <p className="page-description" aria-live="polite" style={{ margin: "20px 0" }}>{results.length} {results.length === 1 ? "title" : "titles"} found</p>}
    <section className="catalog-results" aria-label="Search results" aria-busy={loading}>{results.map(title => <TitleCard key={title.id} title={title} />)}</section>
    {!loading && !results.length && !error && <div className="view-empty"><Icon name="search" size={30} /><h2>{q.trim() ? "No matching titles yet." : "Your next favorite starts here."}</h2><p>{q.trim() ? "Try a shorter name or another spelling. This search explores your catalog; it doesn’t query external indexers." : "Type a title above to explore the collection your administrator has curated."}</p><Link href="/setup" className="btn btn-secondary">New here? Get set up</Link></div>}
  </main>;
}
