"use client";

import { useState } from "react";
import { API_BASE, post, storeSession } from "@/lib/api";
import { t } from "@/lib/i18n";

export default function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string | null>(null);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      const session = await post<{ token?: string; role: string }>("/api/account/change-password", { currentPassword, newPassword });
      storeSession(session.token, session.role);
      setMsg("Password changed.");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const testServer = async () => {
    setHealth(null);
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      const body = await res.json();
      setHealth(`The server${API_BASE ? ` at ${API_BASE}` : ""} answered: ${body.status} (database ${body.db}).`);
    } catch {
      setHealth(`The server${API_BASE ? ` at ${API_BASE}` : ""} could not be reached.`);
    }
  };

  return (
    <main className="container" style={{ maxWidth: 640 }}>
      <h1 style={{ margin: "32px 0 24px" }}>{t("account.settings")}</h1>

      <form className="card" onSubmit={changePassword} style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 16, fontSize: 18 }}>Change password</h2>
        <div className="field">
          <label htmlFor="current-password">Current password</label>
          <input id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => { setCurrentPassword(e.target.value); setError(null); setMsg(null); }} />
        </div>
        <div className="field">
          <label htmlFor="new-password">New password (min. 8 characters)</label>
          <input id="new-password" type="password" autoComplete="new-password" required minLength={8} value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setError(null); setMsg(null); }} />
        </div>
        {msg && <p className="ok-text">{msg}</p>}
        {error && <p className="error-text">{error}</p>}
        <button className="btn">Change password</button>
      </form>

      <div className="card">
        <h2 style={{ marginBottom: 8, fontSize: 18 }}>Server connection</h2>
        <p className="dim" style={{ fontSize: 14, marginBottom: 16 }}>
          {API_BASE
            ? <>This web app talks to the server at <code>{API_BASE}</code> (set when the web app was built, with <code>NEXT_PUBLIC_API_BASE_URL</code>).</>
            : <>This web app and its server share this address, so it works the same on your home network, through a reverse proxy or over a VPN.</>}
        </p>
        {health && <p className="ok-text">{health}</p>}
        <button className="btn btn-secondary" onClick={testServer}>Test connection</button>
      </div>
    </main>
  );
}
