"use client";

import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { LogEntry, PROVIDER_NAMES, ProviderId } from "@/lib/types";

interface AdminHealth {
  db: string;
  users: number;
  brokenLinks?: number;
  enabledIndexers: number;
  downloads: { totalJobs: number; jobsByProvider: Record<string, number>; jobsLastHour: number; recentFailures: number };
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
  if (!health) return <p className="dim">loading...</p>;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat">
          <div className="stat-value">{health.users}</div>
          <div className="stat-label">Users</div>
        </div>
        <div className="stat">
          <div className="stat-value">{health.enabledIndexers}</div>
          <div className="stat-label">Enabled indexers</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ color: (health.brokenLinks ?? 0) > 0 ? "var(--err)" : undefined }}>{health.brokenLinks ?? 0}</div>
          <div className="stat-label">Links needing attention</div>
        </div>
        <div className="stat">
          <div className="stat-value">{health.downloads.totalJobs}</div>
          <div className="stat-label">Total downloads ({health.downloads.jobsLastHour} last hour)</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ color: health.downloads.recentFailures > 0 ? "var(--err)" : undefined }}>
            {health.downloads.recentFailures}
          </div>
          <div className="stat-label">Failures (24h)</div>
        </div>
        <div className="stat">
          <div className="stat-value">
            <span className={`pill ${health.db === "up" ? "pill-ok" : "pill-err"}`}>{health.db}</span>
          </div>
          <div className="stat-label">Database</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-title">Providers</div>
        {health.providers.map((p) => (
          <p key={p.id} style={{ marginBottom: 8, fontSize: 13 }}>
            {PROVIDER_NAMES[p.id]}{" "}
            <span className={`pill ${p.enabled ? "pill-ok" : "pill-dim"}`}>{p.enabled ? "enabled" : "disabled"}</span>{" "}
            <span className="dim">{health.downloads.jobsByProvider[p.id] ?? 0} jobs</span>
          </p>
        ))}
      </div>

      <div className="panel">
        <div className="panel-title">Recent activity</div>
        {logs.length === 0 && <p className="dim">No events yet.</p>}
        {logs.map((log) => (
          <p key={log.id} style={{ fontSize: 12, marginBottom: 6 }}>
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
