"use client";

import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { LogEntry, PROVIDER_IDS } from "@/lib/types";

const TYPES = ["", "signup", "login", "logout", "playback", "provider_error", "admin_action", "system"];
const LEVELS = ["", "info", "warn", "error"];

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [type, setType] = useState("");
  const [level, setLevel] = useState("");
  const [provider, setProvider] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ limit: "200" });
    if (type) params.set("type", type);
    if (level) params.set("level", level);
    if (provider) params.set("provider", provider);
    get<{ logs: LogEntry[] }>(`/api/admin/logs?${params}`)
      .then((r) => setLogs(r.logs))
      .catch((e: Error) => setError(e.message));
  }, [type, level, provider]);

  return (
    <>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((v) => <option key={v} value={v}>{v || "All types"}</option>)}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((v) => <option key={v} value={v}>{v || "All levels"}</option>)}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All providers</option>
          {PROVIDER_IDS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr><th>Time</th><th>Level</th><th>Type</th><th>Message</th><th>Provider</th></tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="dim" style={{ whiteSpace: "nowrap" }}>{new Date(log.createdAt).toLocaleString()}</td>
                <td>
                  <span className={`pill ${log.level === "error" ? "pill-err" : log.level === "warn" ? "pill-warn" : "pill-dim"}`}>
                    {log.level}
                  </span>
                </td>
                <td>{log.type}</td>
                <td>{log.message}</td>
                <td className="dim">{log.provider ?? "—"}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 24 }}>No log entries match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
