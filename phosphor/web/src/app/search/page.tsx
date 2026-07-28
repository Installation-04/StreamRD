"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { del, get, post } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { SavedSearch, SearchResult } from "@/lib/types";

type SortKey = "seeders" | "size" | "date";

export default function SearchPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [minSeeders, setMinSeeders] = useState("0");
  const [maxSizeGb, setMaxSizeGb] = useState("");
  const [sort, setSort] = useState<SortKey>("seeders");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);

  useEffect(() => {
    get<{ savedSearches: SavedSearch[] }>("/api/account/saved-searches")
      .then((res) => setSavedSearches(res.savedSearches))
      .catch(() => {});
  }, []);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const params = new URLSearchParams({ q, sort });
      if (minSeeders) params.set("minSeeders", minSeeders);
      if (maxSizeGb) params.set("maxSizeGb", maxSizeGb);
      const res = await get<{ results: SearchResult[]; errors: string[] }>(`/api/search?${params}`);
      setResults(res.results);
      setErrors(res.errors);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  const saveSearch = async () => {
    if (!q.trim()) return;
    const name = window.prompt("name this saved search:", q);
    if (!name) return;
    try {
      const res = await post<{ savedSearch: SavedSearch }>("/api/account/saved-searches", {
        name,
        query: q,
        minSeeders: minSeeders ? parseInt(minSeeders, 10) : undefined,
        maxSizeGb: maxSizeGb ? parseFloat(maxSizeGb) : undefined,
        sort,
      });
      setSavedSearches((prev) => [res.savedSearch, ...prev]);
    } catch (err) {
      setMessage(`> failed to save: ${(err as Error).message}`);
    }
  };

  const runSaved = (s: SavedSearch) => {
    setQ(s.query);
    setMinSeeders(s.minSeeders != null ? String(s.minSeeders) : "0");
    setMaxSizeGb(s.maxSizeGb != null ? String(s.maxSizeGb) : "");
    setSort(s.sort);
    setTimeout(() => {
      document.querySelector<HTMLFormElement>(".search-bar")?.requestSubmit();
    }, 0);
  };

  const deleteSaved = async (id: string) => {
    setSavedSearches((prev) => prev.filter((s) => s.id !== id));
    try {
      await del(`/api/account/saved-searches/${id}`);
    } catch {
      // best-effort; a stale row in the list is harmless, refresh will fix it
    }
  };

  const addToQueue = async (result: SearchResult) => {
    setAdding(result.link);
    setMessage(null);
    try {
      const res = await post<{ job: { id: string; status: string } }>("/api/downloads", {
        title: result.title,
        sourceUrl: result.link,
        sizeBytes: result.sizeBytes,
        seeders: result.seeders,
        indexerName: result.indexerName,
      });
      setMessage(`> "${result.title}" added to queue (${res.job.status})`);
    } catch (err) {
      setMessage(`> failed: ${(err as Error).message}`);
    } finally {
      setAdding(null);
    }
  };

  return (
    <main className="container">
      <form className="search-bar" onSubmit={runSearch}>
        <input
          type="text"
          autoFocus
          placeholder="search query..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn" disabled={busy}>
          {busy ? "..." : "> search"}
        </button>
      </form>
      <div className="filters">
        <label>
          min seeders
          <input type="number" min={0} value={minSeeders} onChange={(e) => setMinSeeders(e.target.value)} />
        </label>
        <label>
          max size (GB)
          <input type="number" min={0} value={maxSizeGb} onChange={(e) => setMaxSizeGb(e.target.value)} placeholder="any" />
        </label>
        <label>
          sort
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="seeders">seeders</option>
            <option value="size">size</option>
            <option value="date">date</option>
          </select>
        </label>
        <button type="button" className="btn btn-sm" disabled={!q.trim()} onClick={saveSearch}>
          ★ save search
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => router.push("/downloads")}
          style={{ marginLeft: "auto" }}
        >
          view queue →
        </button>
      </div>

      {savedSearches.length > 0 && (
        <div className="saved-searches">
          {savedSearches.map((s) => (
            <span className="saved-search-chip" key={s.id}>
              <button type="button" onClick={() => runSaved(s)}>
                ⟲ {s.name}
              </button>
              <button type="button" className="saved-search-delete" onClick={() => deleteSaved(s.id)} title="delete">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {message && <p className="ok-text">{message}</p>}
      {errors.map((e, i) => (
        <p key={i} className="error-text">
          {e}
        </p>
      ))}

      {results.map((r) => (
        <div className="result-row" key={`${r.indexerId}-${r.link}`}>
          <span className="result-title">{r.title}</span>
          <span className="result-meta">
            <span>{formatBytes(r.sizeBytes)}</span>
            <span>{r.seeders} seeds</span>
            <span className="dim">{r.indexerName}</span>
          </span>
          {r.hasMagnet ? (
            <button className="btn btn-sm" disabled={adding === r.link} onClick={() => addToQueue(r)}>
              {adding === r.link ? "..." : "+ add"}
            </button>
          ) : (
            <span className="dim" style={{ fontSize: 12 }}>
              no magnet
            </span>
          )}
        </div>
      ))}
      {!busy && results.length === 0 && q && errors.length === 0 && (
        <p className="dim" style={{ marginTop: 20 }}>
          no results.
        </p>
      )}
    </main>
  );
}
