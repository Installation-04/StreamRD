"use client";

import { useCallback, useEffect, useState } from "react";
import { get, post, put } from "@/lib/api";
import { DebridAccount, PROVIDER_NAMES, ProviderId } from "@/lib/types";

interface ProviderRow {
  id: ProviderId;
  displayName: string;
  enabled: boolean;
  baseUrl: string | null;
}

export default function AdminProvidersPage() {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    get<{ providers: ProviderRow[] }>("/api/admin/providers").then((r) => setRows(r.providers)).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const toggle = async (row: ProviderRow) => {
    try {
      await put(`/api/admin/providers/${row.id}`, { enabled: !row.enabled });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const test = async (id: ProviderId) => {
    setTests((t) => ({ ...t, [id]: "..." }));
    try {
      const res = await post<{ ok: boolean; account?: DebridAccount; error?: string }>(`/api/admin/providers/${id}/test`);
      setTests((t) => ({
        ...t,
        [id]: res.ok ? `OK: connected as ${res.account?.username}${res.account?.premium ? " (premium)" : ""}` : `FAIL: ${res.error}`,
      }));
    } catch (err) {
      setTests((t) => ({ ...t, [id]: `FAIL: ${(err as Error).message}` }));
    }
  };

  return (
    <>
      {error && <p className="error-text">{error}</p>}
      <p className="dim" style={{ marginBottom: 16, fontSize: 13 }}>
        Connectivity tests use your own API keys (Account → Debrid).
      </p>
      {rows.map((row) => (
        <div key={row.id} className="panel" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <strong>{PROVIDER_NAMES[row.id]}</strong>{" "}
            <span className={`pill ${row.enabled ? "pill-ok" : "pill-dim"}`}>{row.enabled ? "enabled" : "disabled"}</span>
            {tests[row.id] && (
              <p className={tests[row.id].startsWith("OK") ? "ok-text" : "error-text"} style={{ marginTop: 6, fontSize: 12 }}>
                {tests[row.id]}
              </p>
            )}
          </div>
          <button className="btn btn-sm" onClick={() => test(row.id)}>test</button>
          <button className="btn btn-sm" onClick={() => toggle(row)}>{row.enabled ? "disable" : "enable"}</button>
        </div>
      ))}
    </>
  );
}
