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
      setHealth(`Server ${API_BASE}: ${body.status} (db ${body.db})`);
    } catch {
      setHealth(`Cannot reach ${API_BASE}`);
    }
  };

  return (
    <main className="container" style={{ maxWidth: 640 }}>
      <h1 style={{ margin: "32px 0 24px" }}>{t("account.settings")}</h1>

      <form className="card" onSubmit={changePassword} style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 16, fontSize: 18 }}>Change password</h2>
        <div className="field">
          <label>Current password</label>
          <input type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        </div>
        <div className="field">
          <label>New password (min. 8 characters)</label>
          <input type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </div>
        {msg && <p className="ok-text">{msg}</p>}
        {error && <p className="error-text">{error}</p>}
        <button className="btn">Change password</button>
      </form>

      <div className="card">
        <h2 style={{ marginBottom: 8, fontSize: 18 }}>Server connection</h2>
        <p className="dim" style={{ fontSize: 14, marginBottom: 16 }}>
          This web app talks to <code>{API_BASE}</code> (set via{" "}
          <code>NEXT_PUBLIC_API_BASE_URL</code>). Works the same over LAN, reverse proxy
          or VPN.
        </p>
        {health && <p className="ok-text">{health}</p>}
        <button className="btn btn-secondary" onClick={testServer}>Test connection</button>
      </div>
    </main>
  );
}
