"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "@/lib/api";
import { Profile } from "@/lib/types";

const MAX_PROFILES = 5;

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const load = useCallback(() => {
    get<{ profiles: Profile[] }>("/api/account/profiles")
      .then((res) => setProfiles(res.profiles))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/account/profiles", { name: newName.trim() });
      setNewName("");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (p: Profile) => {
    setEditingId(p.id);
    setEditingName(p.name);
  };

  const saveEdit = async (id: string) => {
    if (!editingName.trim()) return;
    try {
      await patch(`/api/account/profiles/${id}`, { name: editingName.trim() });
      setEditingId(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (p: Profile) => {
    if (!confirm(`Remove profile "${p.name}"?`)) return;
    try {
      await del(`/api/account/profiles/${p.id}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="container" style={{ maxWidth: 640 }}>
      <h1 style={{ margin: "32px 0 8px" }}>Profiles</h1>
      <p className="dim" style={{ marginBottom: 24 }}>
        Separate viewing profiles for people sharing this account — up to {MAX_PROFILES}.{" "}
        <Link href="/account/profile" style={{ textDecoration: "underline" }}>
          back to account
        </Link>
      </p>

      {error && <p className="error-text">{error}</p>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 28 }}>
        {profiles.map((p) => (
          <div key={p.id} className="card" style={{ width: 160, textAlign: "center" }}>
            {p.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.avatarUrl}
                alt={p.name}
                loading="lazy"
                style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", margin: "0 auto 10px" }}
              />
            ) : (
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  background: "var(--bg-hover)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 10px",
                  fontSize: 22,
                  fontWeight: 700,
                }}
              >
                {initials(p.name) || "?"}
              </div>
            )}
            {editingId === p.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit(p.id)}
                />
                <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                  <button className="btn btn-sm" onClick={() => saveEdit(p.id)}>
                    Save
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.name}</div>
                <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => startEdit(p)}>
                    Rename
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => remove(p)}>
                    Remove
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {profiles.length < MAX_PROFILES ? (
        <form className="card" onSubmit={create} style={{ maxWidth: 360 }}>
          <div className="field">
            <label>Add a profile</label>
            <input
              placeholder="e.g. Kids"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={40}
            />
          </div>
          <button className="btn" disabled={busy || !newName.trim()}>
            {busy ? "…" : "+ Add profile"}
          </button>
        </form>
      ) : (
        <p className="dim">Profile limit reached — remove one to add another.</p>
      )}
    </main>
  );
}
