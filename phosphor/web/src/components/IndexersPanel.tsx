"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

interface Indexer { id: string; name: string; baseUrl: string; hasKey: boolean; builtin: boolean }

/** Admin → Requests: the indexers searched to find a release for a request by itself (Prowlarr, Jackett or Zilean, all Torznab). */
export default function IndexersPanel() {
  const [list, setList] = useState<Indexer[] | null>(null), [name, setName] = useState(""), [baseUrl, setBaseUrl] = useState(""), [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(""), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const mounted = useRef(false);
  const load = useCallback(async () => { try { const result = await api<{ indexers: Indexer[] }>("/api/admin/request-indexers"); if (mounted.current) setList(result.indexers); } catch { if (mounted.current) setError("Indexers could not be loaded."); } }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  async function run(key: string, work: () => Promise<string | void>) {
    setBusy(key); setError(""); setNotice("");
    try { const message = await work(); if (message && mounted.current) setNotice(message); await load(); }
    catch (problem) { if (mounted.current) setError((problem as Error).message); }
    finally { if (mounted.current) setBusy(""); }
  }
  return <section aria-labelledby="indexers-title" style={{ margin: "24px 0", display: "grid", gap: 12 }}>
    <div><h2 id="indexers-title" style={{ fontSize: 20, margin: "0 0 4px" }}>Release search</h2>
      <p style={{ margin: 0, opacity: 0.85 }}>When you approve a request without pasting a magnet, StreamRD searches these indexers and picks the best release (1080p, H.264 and AAC first, because they play everywhere). Add a Torznab URL from Prowlarr or Jackett, or run Zilean with <code>install.sh --zilean</code> and it is found on its own.</p></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {list && list.length === 0 && <p role="note" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(255,138,31,.45)", background: "rgba(255,138,31,.08)" }}>No indexer yet, so requests need a magnet pasted by hand. Add one below.</p>}
    {list && list.length > 0 && <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>{list.map(indexer => <li key={indexer.id} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", padding: "8px 12px", border: "1px solid rgba(255,255,255,.14)", borderRadius: 10 }}>
      <span><strong>{indexer.name}</strong>{indexer.builtin ? " · found automatically" : ""}<br /><small style={{ opacity: 0.75 }}>{indexer.baseUrl}</small></span>
      <span style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => void run(`test-${indexer.id}`, async () => { const result = await api<{ message: string }>(`/api/admin/request-indexers/${encodeURIComponent(indexer.id)}/test`, { method: "POST", body: "{}" }); return result.message; })}>{busy === `test-${indexer.id}` ? "Testing…" : "Test"}</button>
        {!indexer.builtin && <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => void run(`remove-${indexer.id}`, async () => { await api(`/api/admin/request-indexers/${encodeURIComponent(indexer.id)}`, { method: "DELETE" }); return "Indexer removed."; })}>Remove</button>}
      </span></li>)}</ul>}
    <form onSubmit={event => { event.preventDefault(); void run("add", async () => { const result = await api<{ test: { message: string } }>("/api/admin/request-indexers", { method: "POST", body: JSON.stringify({ name: name || "Indexer", baseUrl, apiKey }) }); setName(""); setBaseUrl(""); setApiKey(""); return `Indexer added. ${result.test.message}`; }); }} style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
      <label>Name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Prowlarr" /></label>
      <label>Torznab URL<input required value={baseUrl} maxLength={2048} onChange={event => setBaseUrl(event.target.value)} placeholder="http://prowlarr:9696/1/api" autoComplete="off" spellCheck={false} /></label>
      <label>API key<input type="password" value={apiKey} maxLength={1500} onChange={event => setApiKey(event.target.value)} autoComplete="off" /></label>
      <button type="submit" className="btn" disabled={Boolean(busy) || !baseUrl.trim()}>{busy === "add" ? "Adding…" : "Add indexer"}</button>
    </form>
  </section>;
}
