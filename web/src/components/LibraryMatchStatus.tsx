"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import styles from "./LibraryMatchStatus.module.css";

export interface MatchSummary { total: number; matched: number; matching: number; review: number; unmatched: number; error: number; notStarted: number; provider: { configured: boolean; automatic: boolean } }
const n = (value: number) => value.toLocaleString();

/** Shows how far automatic metadata matching has got for the signed-in user's own library. */
export default function LibraryMatchStatus({ onProgress }: { onProgress?: () => void }) {
  const [summary, setSummary] = useState<MatchSummary | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const mounted = useRef(true), last = useRef("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const next = await api<MatchSummary>("/api/account/library/metadata/summary");
      if (!mounted.current) return;
      setSummary(next);
      const key = `${next.matched}/${next.review}/${next.unmatched}`;
      if (last.current && key !== last.current) onProgress?.();
      last.current = key;
    } catch { /* The panel is informational; the library itself keeps working. */ }
  }, [onProgress]);
  useEffect(() => { void load(); }, [load]);
  // Keep counting while the server is still working through the library.
  const working = summary ? summary.matching > 0 || (summary.notStarted > 0 && summary.provider.configured && summary.provider.automatic) : false;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => clearInterval(timer);
  }, [working, load]);

  async function retry() {
    setBusy(true); setError(""); setNotice("");
    try {
      let queued = 0, previous = Infinity;
      for (let round = 0; round < 20; round++) {
        const result = await api<{ queued: number; remaining: number; configured: boolean }>("/api/account/library/metadata/rematch", { method: "POST" });
        if (!mounted.current) return;
        if (!result.configured) { setError("No metadata provider is configured yet. Ask the server administrator to add a TMDB or OMDb key in Admin → Metadata."); break; }
        queued += result.queued;
        if (result.queued === 0 || result.remaining >= previous) break;
        previous = result.remaining;
      }
      if (queued) setNotice(`Queued ${n(queued)} ${queued === 1 ? "title" : "titles"} for matching. Results appear as the server works through them.`);
      else if (!error) setNotice("Nothing needed another try.");
      await load();
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Matching could not be restarted."); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!summary || summary.total === 0) return null;
  const waiting = summary.review + summary.unmatched + summary.error + summary.notStarted;
  const percent = Math.round((summary.matched / summary.total) * 100);
  return <section className={styles.panel} aria-label="Metadata matching progress">
    <div className={styles.top}>
      <p className={styles.title}>Artwork &amp; details: {n(summary.matched)} of {n(summary.total)} titles matched ({percent}%)</p>
      <button type="button" className="btn btn-secondary" disabled={busy || !summary.provider.configured || waiting === 0} onClick={() => void retry()}>{busy ? "Queuing…" : waiting ? `Retry matching (${n(waiting)})` : "All titles tried"}</button>
    </div>
    <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={summary.total} aria-valuenow={summary.matched} aria-label="Matched titles"><span style={{ width: `${percent}%` }} /></div>
    <ul className={styles.counts}>
      <li><strong>{n(summary.matching + (summary.provider.automatic ? summary.notStarted : 0))}</strong>waiting or matching</li>
      <li><strong>{n(summary.review)}</strong>need a closer look</li>
      <li><strong>{n(summary.unmatched)}</strong>no match found</li>
      {summary.error > 0 && <li><strong>{n(summary.error)}</strong>failed</li>}
      {!summary.provider.automatic && summary.notStarted > 0 && <li><strong>{n(summary.notStarted)}</strong>not started</li>}
    </ul>
    {!summary.provider.configured && <p className={`${styles.note} ${styles.warn}`}>No metadata provider is configured, so nothing can be matched yet. An administrator can add a TMDB or OMDb key in Admin → Metadata.</p>}
    {summary.provider.configured && !summary.provider.automatic && <p className={`${styles.note} ${styles.warn}`}>Automatic matching is switched off. Press Retry matching to match this library now, or ask an administrator to turn it on in Admin → Metadata.</p>}
    {summary.provider.configured && summary.review + summary.unmatched > 0 && <p className={styles.note}>Titles that are ambiguous (remakes with the same name) or have unreadable file names, like a bare hash, still need a manual choice: open the title and pick the right match.</p>}
    {notice && <p className={styles.note} role="status">{notice}</p>}
    {error && <p className={styles.err} role="alert">{error}</p>}
  </section>;
}
