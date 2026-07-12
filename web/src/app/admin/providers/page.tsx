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
    get<{ providers: ProviderRow[] }>("/api/admin/providers")
      .then((r) => setRows(r.providers))
      .catch((e: Error) => setError(e.message));
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
    setTests((t) => ({ ...t, [id]: "…" }));
    try {
      const res = await post<{ ok: boolean; account?: DebridAccount; error?: string }>(
        `/api/admin/providers/${id}/test`
      );
      setTests((t) => ({
        ...t,
        [id]: res.ok
          ? `✓ Connected as ${res.account?.username}${res.account?.premium ? " (premium)" : ""}`
          : `✗ ${res.error}`,
      }));
    } catch (err) {
      setTests((t) => ({ ...t, [id]: `✗ ${(err as Error).message}` }));
    }
  };

  return (
    <>
      {error && <p className="error-text">{error}</p>}
      <p className="dim" style={{ marginBottom: 16, fontSize: 14 }}>
        Connectivity tests use your own API keys (Account → Debrid services).
      </p>
      {rows.map((row) => (
        <div key={row.id} className="card" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <strong>{PROVIDER_NAMES[row.id]}</strong>{" "}
            <span className={`pill ${row.enabled ? "pill-ok" : "pill-dim"}`}>
              {row.enabled ? "enabled" : "disabled"}
            </span>
            {row.baseUrl && <span className="dim" style={{ fontSize: 13 }}> · base: {row.baseUrl}</span>}
            {tests[row.id] && (
              <p className={tests[row.id].startsWith("✓") ? "ok-text" : "error-text"} style={{ marginTop: 6, fontSize: 13 }}>
                {tests[row.id]}
              </p>
            )}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => test(row.id)}>Test connectivity</button>
          <button className={`btn btn-sm ${row.enabled ? "btn-danger" : ""}`} onClick={() => toggle(row)}>
            {row.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      ))}
    </>
  );
}
