"use client";

import { useCallback, useEffect, useState } from "react";
import { get, patch } from "@/lib/api";
import { User } from "@/lib/types";

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<{ users: User[] }>("/api/admin/users")
      .then((r) => setUsers(r.users))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const update = async (id: string, data: Partial<Pick<User, "role" | "active">>) => {
    setError(null);
    try {
      await patch(`/api/admin/users/${id}`, data);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const visible = users.filter(
    (u) =>
      u.email.toLowerCase().includes(filter.toLowerCase()) ||
      u.displayName.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <>
      <div className="field" style={{ maxWidth: 320 }}>
        <input placeholder="Filter by name or email…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td><span className={`pill ${u.role === "admin" ? "pill-ok" : "pill-dim"}`}>{u.role}</span></td>
                <td><span className={`pill ${u.active ? "pill-ok" : "pill-err"}`}>{u.active ? "active" : "deactivated"}</span></td>
                <td className="dim">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => update(u.id, { role: u.role === "admin" ? "user" : "admin" })}
                  >
                    {u.role === "admin" ? "Demote" : "Make admin"}
                  </button>
                  <button
                    className={`btn btn-sm ${u.active ? "btn-danger" : "btn-secondary"}`}
                    onClick={() => update(u.id, { active: !u.active })}
                  >
                    {u.active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
