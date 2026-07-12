"use client";

import { useEffect, useState } from "react";
import { get, put } from "@/lib/api";
import { t } from "@/lib/i18n";
import { DebridAccount, PROVIDER_IDS, PROVIDER_NAMES, ProviderId } from "@/lib/types";

interface DebridSettings {
  primaryProvider: ProviderId;
  fallbackOrder: ProviderId[];
  keys: Record<ProviderId, string | null>;
}

const KEY_FIELDS: Record<ProviderId, { field: string; help: string }> = {
  realdebrid: {
    field: "realDebridToken",
    help: "API token from real-debrid.com/apitoken",
  },
  alldebrid: {
    field: "allDebridApiKey",
    help: "API key from alldebrid.com/apikeys",
  },
  premiumize: {
    field: "premiumizeApiKey",
    help: "API key from premiumize.me/account",
  },
};

export default function DebridPage() {
  const [settings, setSettings] = useState<DebridSettings | null>(null);
  const [primary, setPrimary] = useState<ProviderId>("realdebrid");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const load = () =>
    get<DebridSettings>("/api/account/debrid").then((res) => {
      setSettings(res);
      setPrimary(res.primaryProvider);
    });

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = { primaryProvider: primary };
      for (const id of PROVIDER_IDS) {
        const value = keys[id];
        if (value !== undefined && value !== "") payload[KEY_FIELDS[id].field] = value;
      }
      await put("/api/account/debrid", payload);
      setKeys({});
      await load();
      setMsg("Debrid settings saved.");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const test = async (id: ProviderId) => {
    setTestResult((r) => ({ ...r, [id]: "…" }));
    try {
      const res = await get<{ account: DebridAccount }>(`/api/debrid/account?provider=${id}`);
      setTestResult((r) => ({
        ...r,
        [id]: `✓ ${res.account.username}${res.account.premium ? " (premium)" : " (free)"}`,
      }));
    } catch (err) {
      setTestResult((r) => ({ ...r, [id]: `✗ ${(err as Error).message}` }));
    }
  };

  if (!settings) return <main className="container"><p className="dim" style={{ marginTop: 40 }}>Loading…</p></main>;

  return (
    <main className="container" style={{ maxWidth: 640 }}>
      <h1 style={{ margin: "32px 0 8px" }}>{t("account.debrid")}</h1>
      <p className="dim" style={{ marginBottom: 24, fontSize: 14 }}>
        Playback uses your primary provider first, then falls back to any other
        configured provider.
      </p>
      <form className="card" onSubmit={save}>
        <div className="field">
          <label>{t("debrid.primary")}</label>
          <select value={primary} onChange={(e) => setPrimary(e.target.value as ProviderId)}>
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>{PROVIDER_NAMES[id]}</option>
            ))}
          </select>
        </div>
        {PROVIDER_IDS.map((id) => (
          <div className="field" key={id}>
            <label>
              {PROVIDER_NAMES[id]} key{" "}
              {settings.keys[id] && <span className="dim">(saved: {settings.keys[id]})</span>}
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ flex: 1 }}
                type="password"
                placeholder={settings.keys[id] ? "•••• leave blank to keep" : KEY_FIELDS[id].help}
                value={keys[id] ?? ""}
                onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
              />
              <button type="button" className="btn btn-secondary" onClick={() => test(id)}>
                {t("debrid.test")}
              </button>
            </div>
            {testResult[id] && (
              <span className={testResult[id].startsWith("✓") ? "ok-text" : "error-text"} style={{ fontSize: 13 }}>
                {testResult[id]}
              </span>
            )}
          </div>
        ))}
        {msg && <p className="ok-text">{msg}</p>}
        {error && <p className="error-text">{error}</p>}
        <button className="btn">Save</button>
      </form>
    </main>
  );
}
