"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { get, patch, post, put } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { User } from "@/lib/types";

type RegistrationMode = "open" | "invite" | "closed";
type Invitation = {
  id: string; email: string; createdAt: string; expiresAt: string;
  acceptedAt: string | null; revokedAt: string | null;
  status: "pending" | "accepted" | "revoked" | "expired";
};
const MODE_COPY: Record<RegistrationMode, { title: string; description: string }> = {
  open: { title: "Open registration", description: "Anyone who can reach this server can create an account. Library access is managed separately." },
  invite: { title: "Invitation only", description: "New members need a one-use invitation addressed to their email. Existing members can sign in normally." },
  closed: { title: "Registration paused", description: "No new accounts can join, including through invitations. Existing members can still sign in." },
};

export default function AdminUsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [mode, setMode] = useState<RegistrationMode>("open");
  const [draftMode, setDraftMode] = useState<RegistrationMode>("open");
  const [filter, setFilter] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareEmail, setShareEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [accounts, access, invites] = await Promise.all([
        get<{ users: User[] }>("/api/admin/users"),
        get<{ mode: RegistrationMode }>("/api/admin/access"),
        get<{ invitations: Invitation[] }>("/api/admin/invitations"),
      ]);
      setUsers(accounts.users);
      setMode(access.mode);
      setDraftMode(access.mode);
      setInvitations(invites.invitations);
      setReady(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const action = async (key: string, run: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await run(); } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const updateUser = (account: User, data: Partial<Pick<User, "role" | "active">>) => action(account.id, async () => {
    const result = await patch<{ user: User }>(`/api/admin/users/${account.id}`, data);
    setUsers((current) => current.map((entry) => entry.id === account.id ? result.user : entry));
    setNotice(`Updated ${account.displayName}.`);
  });

  const signOut = (account: User) => {
    if (!window.confirm(`Sign ${account.displayName} out on all devices? They can sign in again with their password.`)) return;
    void action(account.id, async () => {
      await post(`/api/admin/users/${account.id}/revoke-sessions`);
      setNotice(`${account.displayName} has been signed out on all devices. Their password is unchanged.`);
    });
  };

  const savePolicy = (event: React.FormEvent) => {
    event.preventDefault();
    void action("policy", async () => {
      const result = await put<{ mode: RegistrationMode }>("/api/admin/access", { mode: draftMode });
      setMode(result.mode); setDraftMode(result.mode);
      setNotice(`Saved: ${MODE_COPY[result.mode].title}.`);
    });
  };

  const createInvitation = (event: React.FormEvent) => {
    event.preventDefault();
    void action("invite", async () => {
      const result = await post<{ invitation: Invitation; inviteToken: string }>("/api/admin/invitations", {
        email: inviteEmail.trim(), expiresInDays,
      });
      const link = new URL("/signup", window.location.origin);
      link.hash = new URLSearchParams({ invite: result.inviteToken }).toString();
      setShareLink(link.toString());
      setShareEmail(result.invitation.email);
      setInvitations((current) => [result.invitation, ...current].slice(0, 100));
      setInviteEmail("");
      setNotice("Invitation created. Copy the link below and send it to the invited person.");
      // Replacements revoke older links for this email on the server.
      const latest = await get<{ invitations: Invitation[] }>("/api/admin/invitations");
      setInvitations(latest.invitations);
    });
  };

  const revokeInvitation = (invitation: Invitation) => action(invitation.id, async () => {
    const result = await post<{ invitation: Invitation }>(`/api/admin/invitations/${invitation.id}/revoke`);
    setInvitations((current) => current.map((entry) => entry.id === invitation.id ? result.invitation : entry));
    if (invitation.email === shareEmail) setShareLink(null);
    setNotice(`Invitation revoked for ${invitation.email}.`);
  });

  const copyLink = async () => {
    if (!shareLink) return;
    try { await navigator.clipboard.writeText(shareLink); setNotice("Invitation link copied."); }
    catch { setNotice("Select the invitation link below and copy it manually."); }
  };

  const visible = users.filter((account) => `${account.email} ${account.displayName}`.toLowerCase().includes(filter.toLowerCase()));
  const pending = invitations.filter((invitation) => invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > Date.now()).length;
  const disabled = loading || !ready || Boolean(busy);

  return (
    <div className="access-page">
      <header className="access-heading">
        <div><p className="dim access-eyebrow">YOUR SERVER · YOUR PEOPLE</p><h2>People & access</h2>
          <p className="dim">Choose who can join, manage members and keep control of server access.</p></div>
        {ready && <span className="pill pill-dim">{users.length} members · {pending} pending invitations</span>}
      </header>
      {error && <div className="access-feedback" role="alert"><p className="error-text">{error}</p>
        {!busy && <button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); void load(); }}>Reload access settings</button>}
      </div>}
      {notice && <p className="access-feedback dim" role="status">{notice}</p>}
      {loading && <p className="dim" role="status">Loading people and access settings…</p>}

      <div className="access-grid">
        <section className="card access-section" aria-labelledby="registration-heading">
          <div className="access-section-top"><h3 id="registration-heading">Who can join?</h3>
            {ready && <span className={`pill ${mode === "invite" ? "pill-ok" : "pill-dim"}`}>{MODE_COPY[mode].title}</span>}
          </div>
          <p className="dim access-description">{ready ? MODE_COPY[mode].description : "Waiting for the server’s current registration policy."}</p>
          <form onSubmit={savePolicy}>
            <div className="field">
              <label htmlFor="registration-mode">New account registration</label>
              <select id="registration-mode" value={draftMode} disabled={disabled} onChange={(event) => setDraftMode(event.target.value as RegistrationMode)}>
                <option value="open">Open registration</option><option value="invite">Invitation only</option><option value="closed">Registration paused</option>
              </select>
            </div>
            <p className="dim access-description">{ready ? MODE_COPY[draftMode].description : "Access controls are available when the server responds."}</p>
            <button className="btn btn-secondary" disabled={disabled || draftMode === mode}>{busy === "policy" ? "Saving…" : "Save registration policy"}</button>
          </form>
        </section>
        <section className="card access-section" aria-labelledby="invite-heading">
          <h3 id="invite-heading">Invite someone</h3>
          <p className="dim access-description">Create a personal invitation link. It works once, for the email address you choose. A new invitation replaces any pending link for that email. Send it yourself; this server does not send email.</p>
          <form onSubmit={createInvitation}>
            <div className="field"><label htmlFor="invite-email">Invitation email</label>
              <input id="invite-email" type="email" autoComplete="off" required maxLength={254} value={inviteEmail} disabled={disabled || mode === "closed"} onChange={(event) => setInviteEmail(event.target.value)} />
            </div>
            <div className="access-invite-controls">
              <div className="field"><label htmlFor="invite-expiry">Link expires in</label>
                <select id="invite-expiry" value={expiresInDays} disabled={disabled || mode === "closed"} onChange={(event) => setExpiresInDays(Number(event.target.value))}>
                  <option value={1}>1 day</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
                </select>
              </div>
              <button className="btn" disabled={disabled || mode === "closed"}>{busy === "invite" ? "Creating…" : "Create invitation"}</button>
            </div>
          </form>
          {mode === "closed" && <p className="dim access-description">Switch to invitation-only or open registration before inviting someone.</p>}
          {shareLink && <div className="access-share" role="region" aria-label="New invitation link">
            <strong>Ready for {shareEmail}</strong>
            <p className="dim access-description">Copy this link now. It cannot be retrieved after you leave this page.</p>
            <div className="field"><label htmlFor="invitation-link">Private invitation link</label>
              <input id="invitation-link" value={shareLink} readOnly onFocus={(event) => event.target.select()} />
            </div>
            <div className="access-actions"><button className="btn btn-secondary btn-sm" type="button" onClick={() => { void copyLink(); }}>Copy invitation link</button>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShareLink(null)}>Hide link</button></div>
          </div>}
        </section>
      </div>

      <section className="card access-section" aria-labelledby="members-heading">
        <div className="access-section-top"><div><h3 id="members-heading">Members</h3><p className="dim access-description">Administrators can configure this server and manage other members.</p></div>
          <Link className="btn btn-secondary btn-sm" href="/admin/shared-libraries">Manage shared libraries</Link>
        </div>
        <div className="field access-filter"><label htmlFor="member-filter">Find a member</label><input id="member-filter" placeholder="Name or email" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
        <div className="access-list">
          {visible.map((account) => {
            const self = account.id === user?.id;
            return <article className="access-member" key={account.id}>
              <div className="access-person"><span className="access-avatar" aria-hidden="true">{account.displayName.slice(0, 1).toUpperCase()}</span><div>
                <strong>{account.displayName}{self ? " (you)" : ""}</strong><p className="dim">{account.email}</p>
                <p className="dim access-small">Joined {new Date(account.createdAt).toLocaleDateString()}</p>
              </div></div>
              <div className="access-member-controls"><div className="access-actions"><span className={`pill ${account.role === "admin" ? "pill-ok" : "pill-dim"}`}>{account.role === "admin" ? "Administrator" : "Member"}</span>
                <span className={`pill ${account.active ? "pill-ok" : "pill-err"}`}>{account.active ? "Active" : "Deactivated"}</span></div>
                {!self && <div className="access-actions">
                  <button className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => { void updateUser(account, { role: account.role === "admin" ? "user" : "admin" }); }}>{account.role === "admin" ? "Demote" : "Make admin"}</button>
                  <button className="btn btn-secondary btn-sm" disabled={disabled || !account.active} onClick={() => signOut(account)}>Sign out all devices</button>
                  <button className={`btn btn-sm ${account.active ? "btn-danger" : "btn-secondary"}`} disabled={disabled} onClick={() => { void updateUser(account, { active: !account.active }); }}>{account.active ? "Deactivate" : "Reactivate"}</button>
                </div>}
              </div>
            </article>;
          })}
          {!loading && visible.length === 0 && <p className="dim">No members match your search.</p>}
        </div>
      </section>
      <section className="card access-section" aria-labelledby="invitations-heading">
        <h3 id="invitations-heading">Recent invitations</h3>
        <p className="dim access-description">Up to 100 recent invitations. Accepted members are managed above; revoking an invitation does not deactivate an existing account.</p>
        <div className="access-list">
          {invitations.map((invitation) => {
            const status = invitation.status === "pending" && new Date(invitation.expiresAt).getTime() <= Date.now() ? "expired" : invitation.status;
            return <article className="access-member" key={invitation.id}>
              <div><strong>{invitation.email}</strong><p className="dim access-small">Created {new Date(invitation.createdAt).toLocaleDateString()} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}</p></div>
              <div className="access-actions"><span className={`pill ${status === "accepted" ? "pill-ok" : "pill-dim"}`}>{status}</span>
                {status === "pending" && <button className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => { void revokeInvitation(invitation); }}>Revoke invitation</button>}
              </div>
            </article>;
          })}
          {!loading && invitations.length === 0 && <p className="dim">No invitations yet. Create your first invitation above.</p>}
        </div>
      </section>
      <style jsx>{`
        .access-page { display:grid; gap:24px; min-width:0; }
        .access-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:20px; }
        .access-heading h2 { font-size:28px; letter-spacing:-.7px; margin:8px 0; }
        .access-heading p { max-width:660px; line-height:1.7; font-size:13px; }
        .access-eyebrow { font-size:10px!important; letter-spacing:2px; }
        .access-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; }
        .access-section { padding:24px; margin:0; min-width:0; }
        .access-section h3 { font-size:18px; margin:0; }
        .access-section-top { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
        .access-description { margin:12px 0 18px; font-size:13px; line-height:1.7; }
        .access-section input,.access-section select { width:100%; min-width:0; }
        .access-invite-controls { display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap; }
        .access-invite-controls .field { margin:0; flex:1; min-width:100px; }
        .access-share { padding:18px; border:1px solid var(--border); border-radius:12px; margin-top:20px; background:var(--bg-hover); overflow-wrap:anywhere; }
        .access-feedback { padding:16px 20px; border:1px solid var(--border); border-radius:12px; margin:0; font-size:13px; line-height:1.7; overflow-wrap:anywhere; }
        .access-feedback button { margin-top:10px; }
        .access-filter { max-width:360px; }
        .access-list { display:grid; gap:0; }
        .access-member { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:18px; padding:20px 0; border-top:1px solid var(--border); min-width:0; }
        .access-member strong { font-size:14px; overflow-wrap:anywhere; }
        .access-person { display:flex; align-items:center; gap:14px; min-width:0; }
        .access-person>div { min-width:0; }
        .access-person p { margin-top:5px; font-size:12px; overflow-wrap:anywhere; }
        .access-avatar { flex-shrink:0; width:40px; height:40px; border:1px solid var(--border); border-radius:50%; display:grid; place-items:center; background:var(--bg-hover); font-size:17px; }
        .access-small { font-size:11px!important; margin-top:7px; line-height:1.7; }
        .access-member-controls { display:grid; gap:12px; justify-items:end; }
        .access-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
        @media(max-width:1050px) { .access-grid { grid-template-columns:minmax(0,1fr); } }
        @media(max-width:620px) { .access-section { padding:18px; }.access-member-controls { justify-items:start; width:100%; }.access-heading h2 { font-size:25px; }.access-invite-controls { align-items:stretch; }.access-invite-controls>.btn { margin-top:8px; width:100%; } }
      `}</style>
    </div>
  );
}
