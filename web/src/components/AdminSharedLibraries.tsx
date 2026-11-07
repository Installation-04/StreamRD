"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { LibraryMember, ManagedSharedLibrary, libraryTypeLabel } from "@/lib/shared-libraries";
import styles from "./SharedLibraries.module.css";

function LibraryEditor({ library, people, run, busy }: { library: ManagedSharedLibrary; people: LibraryMember[]; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean> }) {
  const [name, setName] = useState(library.name), [mediaType, setMediaType] = useState(library.mediaType), [enabled, setEnabled] = useState(library.enabled);
  const [userId, setUserId] = useState(""), [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setName(library.name); setMediaType(library.mediaType); setEnabled(library.enabled); }, [library.name, library.mediaType, library.enabled]);
  const base = `/api/admin/shared-libraries/${encodeURIComponent(library.id)}`;
  const available = people.filter(person => person.active && !library.users.some(member => member.id === person.id));
  const selectedUser = available.some(person => person.id === userId) ? userId : "";
  return <section className={styles.managed} aria-label={library.name}>
    <div className={styles.managedHeading}><div><h3>{library.name}</h3><p>{libraryTypeLabel(library.mediaType)} · {library.itemCount} {library.itemCount === 1 ? "title" : "titles"} · {library.users.length} {library.users.length === 1 ? "invited viewer" : "invited viewers"}</p></div><span className={`${styles.badge} ${library.enabled ? "" : styles.disabled}`}>{library.enabled ? "SHARING ENABLED" : "SHARING PAUSED"}</span></div>
    <form onSubmit={event => { event.preventDefault(); void run(() => api(base, { method: "PATCH", body: JSON.stringify({ name: name.trim(), mediaType, enabled }) }), `Saved ${name.trim()}.`); }}>
      <div className={styles.editGrid}><label>Library name<input aria-label={`Library name for ${library.name}`} value={name} required maxLength={80} onChange={event => setName(event.target.value)} /></label><label>Content type<select aria-label={`Content type for ${library.name}`} value={mediaType} onChange={event => setMediaType(event.target.value as ManagedSharedLibrary["mediaType"])}><option value="all">Movies & series</option><option value="movie">Movies</option><option value="series">Series</option></select></label><button type="submit" className="btn btn-secondary" disabled={busy || !name.trim()}>Save library</button></div>
      <label className={styles.enabled}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>Allow viewers to browse and play this library</span></label>
    </form>
    <div className={styles.members}><h4>Who can watch</h4><p>You can watch your own shared libraries. Add another account here to give it access. Pausing a library preserves its access list.</p>
      <div className={styles.memberList}>{library.users.map(member => <div className={styles.member} key={member.id}><div><strong>{member.displayName}{!member.active && " · deactivated"}</strong><p>{member.email}</p></div><button type="button" className="btn btn-secondary btn-sm" aria-label={`Remove access for ${member.email}`} disabled={busy} onClick={() => void run(() => api(`${base}/users/${encodeURIComponent(member.id)}`, { method: "DELETE" }), `Removed access for ${member.displayName}.`)}>Remove access</button></div>)}</div>
      {!library.users.length && <p>No other viewers have access yet.</p>}
      <form className={styles.grant} onSubmit={event => { event.preventDefault(); void run(() => api(`${base}/users`, { method: "POST", body: JSON.stringify({ userId: selectedUser }) }), "Library access granted.").then(saved => { if (saved) setUserId(""); }); }}><label>Add a viewer<select aria-label={`Add a user to ${library.name}`} value={selectedUser} onChange={event => setUserId(event.target.value)}><option value="">Choose an account…</option>{available.map(person => <option key={person.id} value={person.id}>{person.displayName} · {person.email}</option>)}</select></label><button type="submit" className="btn" disabled={busy || !selectedUser}>Grant access</button></form>
      {!available.length && <p>Need another viewer? <Link href="/admin/users" style={{ textDecoration: "underline" }}>Create an invitation in Users.</Link></p>}
    </div>
    <footer className={styles.managedFooter}><p>Includes your current and future imported {library.mediaType === "all" ? "movies and series" : library.mediaType === "movie" ? "movies" : "series"}. Your original private collection and provider account are preserved.</p>{confirmDelete ? <div className={styles.confirm}><span>Remove this shared library and its access grants?</span><button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void run(() => api(base, { method: "DELETE" }), "Shared library removed. Imported titles are preserved.")}>Remove shared library</button><button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button></div> : <button type="button" className={styles.textButton} disabled={busy} onClick={() => setConfirmDelete(true)}>Remove library…</button>}</footer>
  </section>;
}

export default function AdminSharedLibraries() {
  const { user } = useAuth();
  const [libraries, setLibraries] = useState<ManagedSharedLibrary[]>([]), [people, setPeople] = useState<LibraryMember[]>([]);
  const [name, setName] = useState(""), [mediaType, setMediaType] = useState<ManagedSharedLibrary["mediaType"]>("all");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  const mounted = useRef(false), request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const [collections, accounts] = await Promise.all([api<{ libraries: ManagedSharedLibrary[] }>("/api/admin/shared-libraries", { signal: controller.signal }), api<{ users: LibraryMember[] }>("/api/admin/users", { signal: controller.signal })]);
      if (controller.signal.aborted || !mounted.current) return; setLibraries(collections.libraries); setPeople(accounts.users);
    } catch (reason) { if (!controller.signal.aborted && mounted.current) setError(reason instanceof Error ? reason.message : "Sharing could not be loaded."); }
    finally { if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current?.abort(); }; }, [load]);
  async function run(action: () => Promise<unknown>, message: string) {
    if (busy) return false;
    setBusy(true); setError(""); setStatus("");
    try { await action(); if (!mounted.current) return false; setStatus(message); await load(); return true; }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "This change could not be saved."); return false; }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className={styles.admin}>
    <header className={styles.adminIntro}><div><p className={styles.eyebrow}>YOUR SERVER. THEIR NEXT WATCH.</p><h2>Shared libraries</h2><p>Create named collections from your imported account library and choose who can watch. Viewers use the server’s playback connection and never need your credentials.</p></div><Link href="/shared-libraries" className="btn btn-secondary">View shared libraries</Link></header>
    <div className={styles.notice}><strong>Start with your account collection.</strong> <Link href="/account/debrid" style={{ textDecoration: "underline" }}>Connect your provider</Link> and <Link href="/library" style={{ textDecoration: "underline" }}>scan your private library</Link>. Sharing publishes a view of your imports, including future matching titles. The existing curated catalog and Plex/Jellyfin filesystem exports are managed separately.</div>
    <form className={styles.create} onSubmit={event => { event.preventDefault(); void run(() => api("/api/admin/shared-libraries", { method: "POST", body: JSON.stringify({ name: name.trim(), mediaType }) }), `Created ${name.trim()}. Add viewers below.`).then(saved => { if (saved) setName(""); }); }}>
      <label>Library name<input aria-label="Library name" placeholder="Movie night" value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></label><label>Content type<select aria-label="Content type" value={mediaType} onChange={event => setMediaType(event.target.value as ManagedSharedLibrary["mediaType"])}><option value="all">Movies & series</option><option value="movie">Movies</option><option value="series">Series</option></select></label><button type="submit" className="btn" disabled={busy || !name.trim()}>Create shared library</button><p>New libraries begin without other viewers. Each library uses your own imported collection as its source.</p>
    </form>
    {error && <div className={styles.error} role="alert"><p>{error}</p><button type="button" disabled={busy || loading} onClick={() => { setError(""); void load(); }}>Try again</button></div>}
    {status && <p className={styles.status} role="status">{status}</p>}
    {loading && !libraries.length && <p className={styles.notice} role="status">Loading your shared libraries…</p>}
    {!loading && !libraries.length && !error && <section className={styles.empty}><h2>A collection worth sharing.</h2><p>Give your first library a name above. Then invite your viewers from Users and grant their accounts access here.</p><Link className="btn btn-secondary" href="/admin/users">Manage users & invitations</Link></section>}
    {libraries.map(library => <LibraryEditor key={library.id} library={library} people={people.filter(person => person.id !== user?.id)} busy={busy || loading} run={run} />)}
  </div>;
}
