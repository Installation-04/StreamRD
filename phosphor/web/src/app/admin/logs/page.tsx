"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, api, getToken } from "@/lib/api";
import { LogEntry, PROVIDER_IDS } from "@/lib/types";

const TYPES = ["", "signup", "login", "logout", "search", "download", "provider_error", "admin_action", "system"];
const LEVELS = ["", "info", "warn", "error"];
const PAGE_SIZES = [100, 250, 500, 1000];
const FORMATS = [{ id: "txt", label: "Text (.log)" }, { id: "ndjson", label: "JSON lines (.ndjson)" }, { id: "csv", label: "CSV (.csv)" }] as const;
const line = (log: LogEntry) => `${new Date(log.createdAt).toISOString()} ${log.level.toUpperCase().padEnd(5)} ${log.type}${log.provider ? ` [${log.provider}]` : ""} ${log.message.replace(/\r?\n/g, " ")}${log.meta ? " " + log.meta : ""}`;
const field = { background: "var(--bg-raised)", color: "var(--text, var(--fg))", border: "1px solid var(--border)", borderRadius: 8, padding: "9px 11px", font: "inherit", fontSize: 12, colorScheme: "dark light" } as const;
const localInput = (value: string) => value ? new Date(value).toISOString() : "";

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [type, setType] = useState(""), [level, setLevel] = useState(""), [provider, setProvider] = useState("");
  const [q, setQ] = useState(""), [search, setSearch] = useState(""), [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [limit, setLimit] = useState(250), [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState<string | null>(null);
  const request = useRef(0);

  const query = useCallback((extra: Record<string, string> = {}) => {
    const params = new URLSearchParams(extra);
    if (type) params.set("type", type); if (level) params.set("level", level); if (provider) params.set("provider", provider);
    if (search) params.set("q", search); if (from) params.set("from", localInput(from)); if (to) params.set("to", localInput(to));
    return params;
  }, [type, level, provider, search, from, to]);
  const load = useCallback(async (more = false, quiet = false) => {
    const id = ++request.current;
    if (!quiet) setBusy(true);
    setError(null);
    try {
      const r = await api<{ logs: LogEntry[]; nextCursor: string | null }>(`/api/admin/logs?${query({ limit: String(limit), ...(more && cursor ? { cursor } : {}) })}`);
      if (id !== request.current) return;
      setLogs(current => more ? [...current, ...r.logs.filter(row => !current.some(existing => existing.id === row.id))] : r.logs);
      setCursor(r.nextCursor);
    } catch (reason) { if (id === request.current) setError(reason instanceof Error ? reason.message : "Logs could not be loaded."); }
    finally { if (id === request.current && !quiet) setBusy(false); }
  }, [query, limit, cursor]);
  // Reload from the newest entry whenever a filter changes.
  useEffect(() => { void load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [type, level, provider, search, from, to, limit]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(false, true); }, 10000);
    return () => clearInterval(timer);
  }, [live, load]);
  useEffect(() => { const timer = setTimeout(() => setSearch(q.trim()), 350); return () => clearTimeout(timer); }, [q]);

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setNotice(`Copied ${what}.`); }
    catch { setNotice("Your browser blocked copying. Select the text or use Download instead."); }
  }
  async function download(format: string) {
    setNotice("");
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/api/admin/logs/export?${query({ format, max: "50000" })}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error("export");
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? `phosphor-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.${format === "txt" ? "log" : format}`;
      const url = URL.createObjectURL(await response.blob()), a = document.createElement("a");
      a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setNotice(`Downloaded ${name} (up to 50,000 matching entries).`);
    } catch { setError("The download failed. Check your session and try again."); }
  }
  const filtered = Boolean(type || level || provider || search || from || to);
  return (
    <>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "end" }}>
        <input type="search" aria-label="Search log messages" placeholder="Search messages…" value={q} maxLength={200} onChange={e => setQ(e.target.value)} style={{ ...field, minWidth: 220 }} />
        <select aria-label="Type" value={type} onChange={e => setType(e.target.value)}>{TYPES.map(v => <option key={v} value={v}>{v || "All types"}</option>)}</select>
        <select aria-label="Level" value={level} onChange={e => setLevel(e.target.value)}>{LEVELS.map(v => <option key={v} value={v}>{v || "All levels"}</option>)}</select>
        <select aria-label="Provider" value={provider} onChange={e => setProvider(e.target.value)}><option value="">All providers</option>{PROVIDER_IDS.map(p => <option key={p} value={p}>{p}</option>)}</select>
        <label className="dim" style={{ fontSize: 11 }}>From<br /><input type="datetime-local" style={field} value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="dim" style={{ fontSize: 11 }}>To<br /><input type="datetime-local" style={field} value={to} onChange={e => setTo(e.target.value)} /></label>
        <label className="dim" style={{ fontSize: 11 }}>Per page<br /><select value={limit} onChange={e => setLimit(Number(e.target.value))}>{PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        {filtered && <button type="button" className="btn btn-secondary" onClick={() => { setType(""); setLevel(""); setProvider(""); setQ(""); setSearch(""); setFrom(""); setTo(""); }}>Clear filters</button>}
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn btn-secondary" disabled={!logs.length} onClick={() => void copy(logs.map(line).join("\n"), `${logs.length} log ${logs.length === 1 ? "entry" : "entries"}`)}>Copy shown ({logs.length})</button>
        <select aria-label="Download format" defaultValue="" onChange={e => { if (e.target.value) void download(e.target.value); e.target.value = ""; }}>
          <option value="">Download all matching…</option>{FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void load(false)}>{busy ? "Loading…" : "Refresh"}</button>
        <label className="dim" style={{ fontSize: 12 }}><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Live (every 10 s)</label>
        <span className="dim" style={{ fontSize: 12 }} role="status">{notice || `${logs.length} entries shown${cursor ? " · more available" : ""}`}</span>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data">
          <thead><tr><th>Time</th><th>Level</th><th>Type</th><th>Message</th><th>Provider</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {logs.map(log => <Fragment key={log.id}>
              <tr>
                <td className="dim" style={{ whiteSpace: "nowrap" }}>{new Date(log.createdAt).toLocaleString()}</td>
                <td><span className={`pill ${log.level === "error" ? "pill-err" : log.level === "warn" ? "pill-warn" : "pill-dim"}`}>{log.level}</span></td>
                <td>{log.type}</td>
                <td style={{ overflowWrap: "anywhere" }}>{log.message}</td>
                <td className="dim">{log.provider ?? "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {log.meta && <button type="button" className="btn btn-secondary" aria-expanded={open === log.id} aria-label="Show details" onClick={() => setOpen(open === log.id ? null : log.id)}>Details</button>}{" "}
                  <button type="button" className="btn btn-secondary" aria-label="Copy this entry" onClick={() => void copy(line(log), "the entry")}>Copy</button>
                </td>
              </tr>
              {open === log.id && log.meta && <tr><td colSpan={6}><pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11 }}>{(() => { try { return JSON.stringify(JSON.parse(log.meta), null, 2); } catch { return log.meta; } })()}</pre></td></tr>}
            </Fragment>)}
            {!logs.length && !busy && <tr><td colSpan={6} className="dim">{filtered ? "No entries match these filters." : "No log entries yet."}</td></tr>}
          </tbody>
        </table>
      </div>
      {cursor && <p style={{ marginTop: 14 }}><button type="button" className="btn" disabled={busy} onClick={() => void load(true)}>{busy ? "Loading…" : `Load ${limit} more`}</button></p>}
    </>
  );
}
