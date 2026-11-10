"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import styles from "./AccountScanPanel.module.css";

interface Summary { ok: number; unknown: number; broken: number; items: Array<{ id: string; name: string; year: number | null; reason: string | null; checkedAt: string | null }> }

/** Link health for the administrator: how many imports still work, and the titles whose link stopped working. */
export default function LinkHealthPanel() {
  const [data, setData] = useState<Summary | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const mounted = useRef(false);
  const load = useCallback(async () => {
    try { const summary = await api<Summary>("/api/account/library/health"); if (mounted.current) { setData(summary); setError(""); } }
    catch { if (mounted.current) setError("Link health could not be loaded."); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  async function check(id: string) {
    setBusy(id); setError("");
    try { await api(`/api/account/library/${encodeURIComponent(id)}/check`, { method: "POST", body: "{}" }); await load(); }
    catch { if (mounted.current) setError("That link could not be checked right now. Try again in a moment."); }
    finally { if (mounted.current) setBusy(""); }
  }
  if (!data || data.ok + data.unknown + data.broken === 0) return error ? <p role="alert">{error}</p> : null;
  return <section className={styles.panel} aria-label="Link health">
    <header className={styles.header}><div><p>LINK HEALTH</p><h2>{data.broken ? `${data.broken} ${data.broken === 1 ? "link needs" : "links need"} attention` : "Your links are healthy."}</h2>
      <p>Links are checked in the background about once a day. When the only working copy of a title stops working, a replacement is requested automatically; approve it under Requests.</p></div></header>
    {error && <p role="alert">{error}</p>}
    <div className={styles.summary}><div><strong>{data.ok}</strong><span>working</span></div><div><strong>{data.unknown}</strong><span>not checked yet</span></div><div><strong>{data.broken}</strong><span>need attention</span></div></div>
    {data.items.length > 0 && <ul aria-label="Titles that need attention" style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 8 }}>
      {data.items.map(item => <li key={item.id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Link href={`/library/${encodeURIComponent(item.id)}`}>{item.name}{item.year ? ` (${item.year})` : ""}</Link>
        <span style={{ opacity: 0.75, fontSize: 13 }}>{item.reason ?? "No longer served"}</span>
        <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => void check(item.id)}>{busy === item.id ? "Checking…" : "Check again"}</button>
      </li>)}
    </ul>}
  </section>;
}
