"use client";

import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { LogEntry, PROVIDER_NAMES, ProviderId } from "@/lib/types";

interface AdminHealth {
  db: string;
  users: number;
  titles: number;
  playback: {
    totalPlays: number;
    playsByProvider: Record<string, number>;
    playsLastHour: number;
    recentFailures: number;
  };
  providers: Array<{ id: ProviderId; enabled: boolean }>;
}

export default function AdminOverviewPage() {
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<AdminHealth>("/api/admin/health").then(setHealth).catch((e: Error) => setError(e.message));
    get<{ logs: LogEntry[] }>("/api/admin/logs?limit=10").then((r) => setLogs(r.logs)).catch(() => {});
  }, []);

  if (error) return <p className="error-text">{error}</p>;
  if (!health) return <p className="dim">Loading…</p>;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 28 }}>
        <div className="stat">
          <div className="stat-value">{health.users}</div>
          <div className="stat-label">Users</div>
        </div>
        <div className="stat">
          <div className="stat-value">{health.titles}</div>
          <div className="stat-label">Library titles</div>
        </div>
        <div className="stat">
          <div className="stat-value">{health.playback.totalPlays}</div>
          <div className="stat-label">Total plays ({health.playback.playsLastHour} last hour)</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ color: health.playback.recentFailures > 0 ? "var(--err)" : undefined }}>
            {health.playback.recentFailures}
          </div>
          <div className="stat-label">Playback failures (24h)</div>
        </div>
        <div className="stat">
          <div className="stat-value">
            <span className={`pill ${health.db === "up" ? "pill-ok" : "pill-err"}`}>{health.db}</span>
          </div>
          <div className="stat-label">Database</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>Providers</h2>
        {health.providers.map((p) => (
          <p key={p.id} style={{ marginBottom: 8, fontSize: 14 }}>
            {PROVIDER_NAMES[p.id]}{" "}
            <span className={`pill ${p.enabled ? "pill-ok" : "pill-dim"}`}>
              {p.enabled ? "enabled" : "disabled"}
            </span>{" "}
            <span className="dim">
              {health.playback.playsByProvider[p.id] ?? 0} plays
            </span>
          </p>
        ))}
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>Recent activity</h2>
        {logs.length === 0 && <p className="dim">No events yet.</p>}
        {logs.map((log) => (
          <p key={log.id} style={{ fontSize: 13, marginBottom: 6 }}>
            <span className="dim">{new Date(log.createdAt).toLocaleString()}</span>{" "}
            <span className={`pill ${log.level === "error" ? "pill-err" : log.level === "warn" ? "pill-warn" : "pill-dim"}`}>
              {log.type}
            </span>{" "}
            {log.message}
          </p>
        ))}
      </div>
    </>
  );
}
