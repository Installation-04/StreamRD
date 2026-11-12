"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { put } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { User } from "@/lib/types";

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setAvatarUrl(user.avatarUrl ?? "");
    }
  }, [user]);

  if (!user) return <main className="container"><p className="dim" style={{ marginTop: 40 }}>Loading…</p></main>;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      await put<{ user: User }>("/api/account/update", {
        displayName,
        avatarUrl: avatarUrl || null,
      });
      await refresh();
      setMsg("Profile saved.");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="container" style={{ maxWidth: 640 }}>
      <h1 style={{ margin: "32px 0 8px" }}>{t("account.profile")}</h1>
      <p className="dim" style={{ marginBottom: 24 }}>
        {user.email} · role: {user.role} ·{" "}
        <Link href="/account/settings" style={{ textDecoration: "underline" }}>{t("account.settings")}</Link>
        {user.role === "admin" && <>{" · "}<Link href="/account/debrid" style={{ textDecoration: "underline" }}>{t("account.debrid")}</Link></>}
      </p>
      <form className="card" onSubmit={save}>
        <div className="field">
          <label>{t("auth.displayName")}</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="field">
          <label>Avatar URL</label>
          <input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />
        </div>
        {msg && <p className="ok-text">{msg}</p>}
        {error && <p className="error-text">{error}</p>}
        <button className="btn">Save</button>
      </form>
    </main>
  );
}
