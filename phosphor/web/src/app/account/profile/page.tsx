"use client";

import { useEffect, useState } from "react";
import { API_BASE, put } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { User } from "@/lib/types";

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [health, setHealth] = useState<string | null>(null);

  useEffect(() => {
    if (user) setDisplayName(user.displayName);
  }, [user]);

  if (!user) return <main className="container"><p className="dim" style={{ marginTop: 40 }}>loading...</p></main>;

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      await put<{ user: User }>("/api/account/update", { displayName });
      await refresh();
      setMsg("> profile saved");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      await put("/api/account/change-password", { currentPassword, newPassword });
      setMsg("> password changed");
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
      setHealth(`server ${API_BASE}: ${body.status} (db ${body.db})`);
    } catch {
      setHealth(`cannot reach ${API_BASE}`);
    }
  };

  return (
    <main className="container" style={{ maxWidth: 640 }}>
      <div className="panel-title" style={{ margin: "24px 0 16px" }}>
        Profile
      </div>
      <p className="dim" style={{ marginBottom: 16, fontSize: 13 }}>
        {user.email} · role: {user.role}
      </p>
      <form className="panel" onSubmit={saveProfile} style={{ marginBottom: 20 }}>
        <div className="field">
          <label>Display name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <button className="btn">save</button>
      </form>

      <form className="panel" onSubmit={changePassword} style={{ marginBottom: 20 }}>
        <div className="panel-title">Change password</div>
        <div className="field">
          <label>Current password</label>
          <input type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        </div>
        <div className="field">
          <label>New password (min. 8 characters)</label>
          <input type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </div>
        <button className="btn">change password</button>
      </form>

      {(msg || error) && (
        <p className={error ? "error-text" : "ok-text"}>{error ?? msg}</p>
      )}

      <div className="panel">
        <div className="panel-title">Server connection</div>
        <p className="dim" style={{ fontSize: 12, marginBottom: 14 }}>
          This client talks to <code>{API_BASE}</code> (set via <code>NEXT_PUBLIC_API_BASE_URL</code>).
        </p>
        {health && <p className="ok-text">{health}</p>}
        <button className="btn btn-sm" onClick={testServer}>test connection</button>
      </div>
    </main>
  );
}
