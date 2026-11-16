"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import styles from "./LogMonitor.module.css";

interface Source { id: string; label: string; group: string; state: string; lines?: number }
interface Line { time: string; source: string; level?: string; text: string }
const GROUPS = ["StreamRD", "Add-ons", "Media servers", "Services"];
const TAILS = [100, 300, 1000];
/** The level of a line: from the event log's own level, else from its words. */
function levelOf(line: Line): "error" | "warn" | "info" {
  if (line.level === "error" || line.level === "warn") return line.level;
  if (/\b(error|fatal|exception|panic|failed|failure|critical|unhandled)\b/i.test(line.text)) return "error";
  if (/\b(warn|warning|deprecated|retry|retrying|timeout|timed out)\b/i.test(line.text)) return "warn";
  return "info";
}
const clock = (time: string) => { const at = new Date(time); return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour12: false }); };
const download = (name: string, text: string) => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); };

/**
 * Every program StreamRD runs, in one place: pick one, or all of them merged by time, and watch its output as it is written. Sources are the
 * event log, the processes inside the StreamRD container, the add-ons and media servers, and Zilean and Zurg. Tokens are blanked before a
 * line leaves the server.
 */
export default function LogMonitor() {
  const [sources, setSources] = useState<Source[]>([]), [note, setNote] = useState<string | null>(null), [picked, setPicked] = useState("all"), [lines, setLines] = useState<Line[]>([]);
  const [tail, setTail] = useState(300), [filter, setFilter] = useState(""), [follow, setFollow] = useState(true), [wrap, setWrap] = useState(true), [error, setError] = useState(""), [loading, setLoading] = useState(true), [copied, setCopied] = useState(false);
  const pane = useRef<HTMLDivElement>(null), pinned = useRef(true), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A link from another page (for example an add-on card's "See its log") opens on that source.
  useEffect(() => { try { const wanted = new URLSearchParams(window.location.search).get("source"); if (wanted && /^(all|events|(core|app|svc):[a-z0-9-]{1,30})$/.test(wanted)) setPicked(wanted); } catch { /* the default stays */ } }, []);
  const loadSources = useCallback(async () => {
    try { const found = await api<{ sources: Source[]; note: string | null }>("/api/admin/monitor/sources"); if (mounted.current) { setSources(found.sources); setNote(found.note); } } catch { /* the list keeps what it had */ }
  }, []);
  useEffect(() => { void loadSources(); const timer = setInterval(() => void loadSources(), 15_000); return () => clearInterval(timer); }, [loadSources]);
  const loadLines = useCallback(async () => {
    try {
      const params = new URLSearchParams({ source: picked, tail: String(tail) }); if (filter.trim()) params.set("q", filter.trim());
      const found = await api<{ lines: Line[] }>(`/api/admin/monitor/logs?${params}`);
      if (mounted.current) { setLines(found.lines); setError(""); setLoading(false); }
    } catch (reason) { if (mounted.current) { setError(reason instanceof Error ? reason.message : "The logs could not be loaded."); setLoading(false); } }
  }, [picked, tail, filter]);
  useEffect(() => { setLoading(true); const wait = setTimeout(() => void loadLines(), filter ? 300 : 0); return () => clearTimeout(wait); }, [loadLines, filter]);
  useEffect(() => { if (!follow) return; const timer = setInterval(() => void loadLines(), 3000); return () => clearInterval(timer); }, [follow, loadLines]);
  // Stay at the newest line while following, unless the reader has scrolled up to read.
  useEffect(() => { const element = pane.current; if (element && follow && pinned.current) element.scrollTop = element.scrollHeight; }, [lines, follow]);
  const labels = useMemo(() => Object.fromEntries(sources.map(source => [source.id, source.label])), [sources]);
  const text = useMemo(() => lines.map(line => `${line.time}  ${picked === "all" ? `[${labels[line.source] ?? line.source}] ` : ""}${line.text}`).join("\n"), [lines, labels, picked]);
  const current = picked === "all" ? "All apps" : labels[picked] ?? picked;

  return <div className={styles.page}>
    <h2 className={styles.title}>Monitor</h2>
    <p className={styles.intro}>What every program writes, in one place: StreamRD, qBittorrent, your add-ons, Plex or Jellyfin, Zilean and Zurg. Pick one, or watch all of them together in time order. Passwords and tokens are hidden.</p>
    {note && <p className={styles.notice} role="note">{note}</p>}
    <div className={styles.layout}>
      <nav className={styles.sources} aria-label="Log sources">
        <button type="button" className={`${styles.source} ${picked === "all" ? styles.on : ""}`} aria-pressed={picked === "all"} onClick={() => setPicked("all")}>All apps</button>
        {GROUPS.map(group => { const list = sources.filter(source => source.group === group); if (!list.length) return null;
          return <div key={group} className={styles.group}><p>{group}</p>
            {list.map(source => <button type="button" key={source.id} className={`${styles.source} ${picked === source.id ? styles.on : ""}`} aria-pressed={picked === source.id} onClick={() => setPicked(source.id)}>
              <span className={`${styles.dot} ${source.state === "running" ? styles.up : source.state === "failed" ? styles.bad : ""}`} role="img" aria-label={source.state} />{source.label}</button>)}
          </div>; })}
      </nav>
      <section className={styles.viewer} aria-label={`${current} log`}>
        <div className={styles.bar}>
          <strong>{current}</strong>
          <label className={styles.inline}>Filter<input type="search" value={filter} maxLength={200} onChange={event => setFilter(event.target.value)} placeholder="error, a title, a word…" /></label>
          <label className={styles.inline}>Lines<select value={tail} onChange={event => setTail(Number(event.target.value))}>{TAILS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className={styles.check}><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />Follow</label>
          <label className={styles.check}><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />Wrap lines</label>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void loadLines()}>Refresh</button>
          <button type="button" className="btn btn-sm btn-secondary" disabled={!lines.length} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy"}</button>
          <button type="button" className="btn btn-sm btn-secondary" disabled={!lines.length} onClick={() => download(`${current.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-logs.txt`, text)}>Download</button>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div ref={pane} className={`${styles.pane} ${wrap ? styles.wrap : ""}`} role="log" aria-live="off" tabIndex={0} aria-label={`${current} output`}
          onScroll={event => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
          {loading && !lines.length ? <p className={styles.empty}>Loading…</p>
            : !lines.length ? <p className={styles.empty}>{filter ? "Nothing matches that filter." : "Nothing written yet."}</p>
            : lines.map((line, index) => <div key={index} className={`${styles.line} ${styles[levelOf(line)]}`}>
              <time dateTime={line.time} title={line.time}>{clock(line.time)}</time>
              {picked === "all" && <span className={styles.tag}>{labels[line.source] ?? line.source}</span>}
              <span>{line.text}</span></div>)}
        </div>
        <p className={styles.small}>{follow ? "Updating every few seconds." : "Paused."} Showing the last {lines.length} {lines.length === 1 ? "line" : "lines"}.</p>
      </section>
    </div>
  </div>;
}
