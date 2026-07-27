"use client";

import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "@/lib/api";
import { IndexerConfig } from "@/lib/types";

export default function AdminIndexersPage() {
  const [indexers, setIndexers] = useState<IndexerConfig[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    get<{ indexers: IndexerConfig[] }>("/api/admin/indexers").then((r) => setIndexers(r.indexers)).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await post("/api/admin/indexers", { name, baseUrl, apiKey, enabled: true });
      setName("");
      setBaseUrl("");
      setApiKey("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggle = async (idx: IndexerConfig) => {
    await patch(`/api/admin/indexers/${idx.id}`, { enabled: !idx.enabled });
    load();
  };

  const remove = async (idx: IndexerConfig) => {
    if (!confirm(`Remove indexer "${idx.name}"?`)) return;
    await del(`/api/admin/indexers/${idx.id}`);
    load();
  };

  const test = async (idx: IndexerConfig) => {
    setTests((t) => ({ ...t, [idx.id]: "..." }));
    try {
      const res = await post<{ ok: boolean; sampleResultCount?: number; error?: string }>(`/api/admin/indexers/${idx.id}/test`);
      setTests((t) => ({ ...t, [idx.id]: res.ok ? `OK: ${res.sampleResultCount} sample results` : `FAIL: ${res.error}` }));
    } catch (err) {
      setTests((t) => ({ ...t, [idx.id]: `FAIL: ${(err as Error).message}` }));
    }
  };

  return (
    <>
      <p className="dim" style={{ marginBottom: 16, fontSize: 13 }}>
        Paste the Torznab endpoint URL from Jackett ("all" indexers feed, or a single indexer) or a Prowlarr
        indexer's Torznab URL, plus its API key. Both tools speak the same protocol.
      </p>
      <form className="panel" onSubmit={add} style={{ marginBottom: 20 }}>
        <div className="panel-title">Add indexer</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr auto", gap: 10 }}>
          <div className="field">
            <label>Name</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>Torznab URL</label>
            <input
              required
              placeholder="http://jackett:9117/api/v2.0/indexers/all/results/torznab/api"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label>API key</label>
            <input required type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <button className="btn" style={{ height: 38, alignSelf: "end" }}>
            + add
          </button>
        </div>
      </form>
      {error && <p className="error-text">{error}</p>}

      {indexers.map((idx) => (
        <div key={idx.id} className="panel" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <strong>{idx.name}</strong>{" "}
            <span className={`pill ${idx.enabled ? "pill-ok" : "pill-dim"}`}>{idx.enabled ? "enabled" : "disabled"}</span>
            <p className="dim" style={{ fontSize: 12, marginTop: 4 }}>{idx.baseUrl}</p>
            {tests[idx.id] && (
              <p className={tests[idx.id].startsWith("OK") ? "ok-text" : "error-text"} style={{ fontSize: 12, marginTop: 4 }}>
                {tests[idx.id]}
              </p>
            )}
          </div>
          <button className="btn btn-sm" onClick={() => test(idx)}>test</button>
          <button className="btn btn-sm" onClick={() => toggle(idx)}>{idx.enabled ? "disable" : "enable"}</button>
          <button className="btn btn-sm btn-danger" onClick={() => remove(idx)}>remove</button>
        </div>
      ))}
    </>
  );
}
