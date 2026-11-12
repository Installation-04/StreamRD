"use client";

import { useEffect, useState } from "react";
import { authFetch, get, post, put } from "@/lib/api";
import ServerSettingsPanel from "@/components/ServerSettingsPanel";
import { PROVIDER_IDS, PROVIDER_NAMES, ProviderId, ServerSettings } from "@/lib/types";

export default function AdminServerPage() {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importText, setImportText] = useState("");

  useEffect(() => {
    get<{ settings: ServerSettings }>("/api/admin/server")
      .then((r) => setSettings(r.settings))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!settings) return error ? <p className="error-text">{error}</p> : <p className="dim">Loading…</p>;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      const res = await put<{ settings: ServerSettings }>("/api/admin/server", settings);
      setSettings(res.settings);
      setMsg("Server settings saved.");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const move = (id: ProviderId, dir: -1 | 1) => {
    const order = [...settings.providerOrder];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setSettings({ ...settings, providerOrder: order });
  };

  const toggleDisabled = (id: ProviderId) => {
    const disabled = settings.disabledProviders.includes(id)
      ? settings.disabledProviders.filter((p) => p !== id)
      : [...settings.disabledProviders, id];
    setSettings({ ...settings, disabledProviders: disabled });
  };

  const exportConfig = async () => {
    const res = await authFetch("/api/admin/export/config");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "streamrd-config.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importConfig = async () => {
    setMsg(null);
    setError(null);
    try {
      const parsed = JSON.parse(importText);
      const res = await post<{ importedTitles: number }>("/api/admin/import/config", parsed);
      setMsg(`Import complete (${res.importedTitles} titles).`);
      setImportText("");
    } catch (err) {
      setError(err instanceof SyntaxError ? "Invalid JSON" : (err as Error).message);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
    <ServerSettingsPanel conversion />
    <form onSubmit={save}>
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>Global provider order & availability</h2>
        {settings.providerOrder.map((id, i) => (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ width: 140 }}>{i + 1}. {PROVIDER_NAMES[id]}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => move(id, -1)}>↑</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => move(id, 1)}>↓</button>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={!settings.disabledProviders.includes(id)}
                onChange={() => toggleDisabled(id)}
              />
              enabled globally
            </label>
          </div>
        ))}
        <p className="dim" style={{ fontSize: 13 }}>
          Users without a personal fallback order inherit this order. Missing providers:{" "}
          {PROVIDER_IDS.filter((p) => !settings.providerOrder.includes(p)).map((p) => PROVIDER_NAMES[p]).join(", ") || "none"}
        </p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>Timeouts & retries</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label>Provider timeout (ms)</label>
            <input
              type="number"
              min={1000}
              max={120000}
              value={settings.providerTimeoutMs}
              onChange={(e) => setSettings({ ...settings, providerTimeoutMs: parseInt(e.target.value || "15000", 10) })}
            />
          </div>
          <div className="field">
            <label>Max playback attempts (total source/provider attempts)</label>
            <input
              type="number"
              min={1}
              max={10}
              value={settings.maxPlaybackAttempts}
              onChange={(e) => setSettings({ ...settings, maxPlaybackAttempts: parseInt(e.target.value || "3", 10) })}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>Access</h2>
        <label style={{ display: "flex", gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={settings.requireLoginForPlayback}
            onChange={(e) => setSettings({ ...settings, requireLoginForPlayback: e.target.checked })}
          />
          Require login for playback
        </label>
      </div>

      {msg && <p className="ok-text">{msg}</p>}
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button className="btn">Save settings</button>
        <button type="button" className="btn btn-secondary" onClick={exportConfig}>
          Export config (JSON)
        </button>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>Import config</h2>
        <div className="field">
          <textarea
            rows={4}
            placeholder="Paste a previously exported streamrd-config.json…"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
        </div>
        <button type="button" className="btn btn-secondary" onClick={importConfig} disabled={!importText.trim()}>
          Import
        </button>
      </div>
    </form>
    </div>
  );
}
