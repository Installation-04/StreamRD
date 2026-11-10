"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, authFetch } from "@/lib/api";
import styles from "./SystemMaintenance.module.css";

interface Backup { name: string; kind: "manual" | "pre-update" | "pre-restore" | "pre-upgrade" | "other"; sizeBytes: number; createdAt: string }
interface Maintenance { backups: Backup[]; pendingRestore: { backup: string; requestedAt: string } | null; restartSupported: boolean }
interface UpdateInfo { current: string; latest: string | null; updateAvailable: boolean; publishedAt: string | null; url: string | null; checkEnabled: boolean; checkedAt: string | null; error: string | null; canApply: boolean }
const KIND: Record<Backup["kind"], string> = { manual: "Manual", "pre-update": "Before update", "pre-restore": "Before restore", "pre-upgrade": "Before upgrade", other: "Other" };
const when = (value: string | null) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded";
const size = (bytes: number) => bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const message = (reason: unknown, fallback: string) => reason instanceof ApiError && reason.status !== 401 && reason.status !== 403 ? reason.message : fallback;

export default function SystemMaintenance() {
  const [maintenance, setMaintenance] = useState<Maintenance | null>(null), [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null), [typed, setTyped] = useState(""), [confirmUpdate, setConfirmUpdate] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loadMaintenance = useCallback(async () => {
    try { const next = await api<Maintenance>("/api/admin/system/maintenance"); if (mounted.current) setMaintenance(next); }
    catch (reason) { if (mounted.current) setError(message(reason, "Backups could not be loaded. Check your administrator session.")); }
  }, []);
  const checkUpdates = useCallback(async (refresh = false) => {
    setBusy("check"); setError("");
    try { const next = await api<UpdateInfo>(`/api/admin/system/update${refresh ? "?refresh=1" : ""}`); if (mounted.current) setUpdate(next); }
    catch (reason) { if (mounted.current) setError(message(reason, "Updates could not be checked.")); }
    finally { if (mounted.current) setBusy(""); }
  }, []);
  useEffect(() => { void loadMaintenance(); void checkUpdates(); }, [loadMaintenance, checkUpdates]);
  async function run(label: string, work: () => Promise<void>, failure: string) {
    setBusy(label); setError(""); setNotice("");
    try { await work(); } catch (reason) { if (mounted.current) setError(message(reason, failure)); }
    finally { if (mounted.current) setBusy(""); }
  }
  const createBackup = () => run("create", async () => { await api("/api/admin/system/backups", { method: "POST" }); setNotice("Backup created and verified."); await loadMaintenance(); }, "The backup could not be created.");
  const verify = (name: string) => run("verify:" + name, async () => { const result = await api<{ ok: boolean; reason?: string }>(`/api/admin/system/backups/${encodeURIComponent(name)}/verify`, { method: "POST" }); setNotice(result.ok ? `${name} passed its integrity check and can be restored.` : `${name} cannot be restored (${result.reason ?? "unrecognized"}).`); }, "The backup could not be verified.");
  const remove = (name: string) => run("delete:" + name, async () => { if (!window.confirm(`Delete backup ${name}? This cannot be undone.`)) return; await api(`/api/admin/system/backups/${encodeURIComponent(name)}`, { method: "DELETE" }); setNotice("Backup deleted."); await loadMaintenance(); }, "The backup could not be deleted.");
  const download = (name: string) => run("download:" + name, async () => {
    const response = await authFetch(`/api/admin/system/backups/${encodeURIComponent(name)}/download`);
    if (!response.ok) throw new Error("download");
    const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }, "The backup could not be downloaded.");
  const stageRestore = (name: string) => run("restore", async () => {
    const result = await api<{ restarting: boolean }>(`/api/admin/system/backups/${encodeURIComponent(name)}/restore`, { method: "POST", body: JSON.stringify({ confirm: "RESTORE", restart: maintenance?.restartSupported === true }) });
    setRestoring(null); setTyped("");
    setNotice(result.restarting ? "Restore staged. The server is restarting and will restore this backup on startup. Sign in again in a minute." : "Restore staged. Restart the server to apply it.");
    await loadMaintenance();
  }, "The restore could not be staged. Nothing was changed.");
  const cancelRestore = () => run("cancel", async () => { await api("/api/admin/system/restore", { method: "DELETE" }); setNotice("Staged restore cancelled."); await loadMaintenance(); }, "The staged restore could not be cancelled.");
  const restart = () => run("restart", async () => { if (!window.confirm("Restart the server now? Everyone will be briefly disconnected.")) return; await api("/api/admin/system/restart", { method: "POST" }); setNotice("Restarting. Reload this page in a minute."); }, "The server could not be restarted from here.");
  const applyUpdate = () => run("update", async () => {
    if (!update?.latest) return;
    const result = await api<{ backup: Backup }>("/api/admin/system/update", { method: "POST", body: JSON.stringify({ version: update.latest }) });
    setConfirmUpdate(false); setNotice(`Backup ${result.backup.name} was created and the update was requested. The server will restart into v${update.latest} when your updater finishes.`); await loadMaintenance();
  }, "The update could not be requested. Your data was not changed.");
  return <div className={styles.wrap}>
    <section className={styles.panel} aria-labelledby="update-heading">
      <div className={styles.heading}><div><p className={styles.eyebrow}>RELEASES</p><h3 id="update-heading">Updates</h3></div>
        <div className={styles.actions}><button type="button" className="btn btn-secondary" disabled={busy !== ""} onClick={() => void checkUpdates(true)}>{busy === "check" ? "Checking…" : "Check for updates"}</button></div></div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.success} role="status">{notice}</p>}
      {update && <dl className={styles.facts}>
        <div><dt>Installed</dt><dd>v{update.current}</dd></div>
        <div><dt>Latest release</dt><dd>{update.latest ? `v${update.latest}` : update.checkEnabled ? "Unknown" : "Checks disabled"}</dd></div>
        <div><dt>Status</dt><dd className={update.updateAvailable ? styles.warn : styles.ok}>{update.updateAvailable ? "Update available" : update.latest ? "Up to date" : "Not checked"}</dd></div>
        <div><dt>Published</dt><dd>{when(update.publishedAt)}</dd></div>
      </dl>}
      {update?.error && <p className={styles.notice}>{update.error}</p>}
      {update?.updateAvailable && update.url && <p className={styles.copy}><a href={update.url} target="_blank" rel="noreferrer">Read the v{update.latest} release notes ↗</a></p>}
      {update?.updateAvailable && !update.canApply && <div className={styles.notice}>
        <strong>How to update.</strong> In your install folder run:
        <pre style={{ margin: "8px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>docker compose pull &amp;&amp; docker compose up -d</pre>
        <div className={styles.actions}><button type="button" className="btn btn-secondary" onClick={() => { void navigator.clipboard?.writeText("docker compose pull && docker compose up -d").then(() => setNotice("Update command copied."), () => setNotice("Your browser blocked copying; select the command above.")); }}>Copy command</button></div>
        <p className={styles.hint}>Your settings (<code>config</code>) and downloads (<code>data</code>) are kept; the database is snapshotted before any upgrade. Running the older split install? Use <code>git pull</code> then <code>docker compose up -d --build</code>. For a one-click button, point <code>UPDATE_WEBHOOK_URL</code> at an updater such as Watchtower.</p>
      </div>}
      {update?.updateAvailable && update.canApply && !confirmUpdate && <button type="button" className="btn" disabled={busy !== ""} onClick={() => setConfirmUpdate(true)}>Update to v{update.latest}…</button>}
      {update?.updateAvailable && update.canApply && confirmUpdate && <div className={styles.confirm}><p className={styles.copy}>This creates a verified backup, then asks your updater to roll out v{update.latest}. The server restarts and applies database upgrades on startup. Users are briefly disconnected.</p><div className={styles.actions}><button type="button" className="btn" disabled={busy !== ""} onClick={() => void applyUpdate()}>{busy === "update" ? "Backing up…" : "Back up and update"}</button><button type="button" className="btn btn-secondary" disabled={busy !== ""} onClick={() => setConfirmUpdate(false)}>Cancel</button></div></div>}
    </section>
    <section className={styles.panel} aria-labelledby="backup-restore-heading">
      <div className={styles.heading}><div><p className={styles.eyebrow}>RECOVERY</p><h3 id="backup-restore-heading">Backups &amp; restore</h3></div>
        <div className={styles.actions}><button type="button" className="btn" disabled={busy !== ""} onClick={() => void createBackup()}>{busy === "create" ? "Creating backup…" : "Create backup"}</button></div></div>
      <p className={styles.copy}>Backups are consistent, integrity-checked snapshots of the database, stored beside it. Download a copy and keep it off this host: a backup on the same volume does not protect against losing that volume. Backups contain account data and provider credentials; treat them as private.</p>
      {maintenance?.pendingRestore && <div className={styles.notice} role="status"><strong>Restore staged:</strong> <span className={styles.name}>{maintenance.pendingRestore.backup}</span> will replace the current data at the next start. A safety backup of the current data was taken.
        <div className={styles.actions} style={{ marginTop: 10 }}>{maintenance.restartSupported && <button type="button" className="btn" disabled={busy !== ""} onClick={() => void restart()}>Restart now to apply</button>}<button type="button" className="btn btn-secondary" disabled={busy !== ""} onClick={() => void cancelRestore()}>Cancel restore</button></div>
        {!maintenance.restartSupported && <p className={styles.copy} style={{ marginTop: 8 }}>Restart the container or service yourself to apply it.</p>}</div>}
      {!maintenance ? <p className={styles.empty} role="status">Loading backups…</p> : maintenance.backups.length === 0 ? <p className={styles.empty}>No backups yet. Create one before changing anything important.</p> :
        <ul className={styles.list} aria-label="Database backups">{maintenance.backups.map(backup => <li key={backup.name} className={styles.row}>
          <div><div className={styles.name}>{backup.name}</div><div className={styles.meta}><span className={styles.tag}>{KIND[backup.kind]}</span><span>{when(backup.createdAt)}</span><span>{size(backup.sizeBytes)}</span></div></div>
          <div className={styles.rowActions}>
            <button type="button" className="btn btn-secondary" disabled={busy !== ""} aria-label={`Download ${backup.name}`} onClick={() => void download(backup.name)}>Download</button>
            <button type="button" className="btn btn-secondary" disabled={busy !== ""} aria-label={`Verify ${backup.name}`} onClick={() => void verify(backup.name)}>Verify</button>
            <button type="button" className="btn btn-secondary" disabled={busy !== "" || maintenance.pendingRestore !== null} aria-label={`Restore ${backup.name}`} onClick={() => { setRestoring(backup.name); setTyped(""); }}>Restore…</button>
            <button type="button" className={`btn btn-secondary ${styles.danger}`} disabled={busy !== ""} aria-label={`Delete ${backup.name}`} onClick={() => void remove(backup.name)}>Delete</button>
          </div>
          {restoring === backup.name && <div className={styles.confirm}>
            <p className={styles.copy}>Restoring replaces <strong>all current data</strong> (accounts, libraries, settings) with this backup. A safety backup of the current data is taken first, and the swap happens at the next start so a running server is never changed underneath.</p>
            <label>Type RESTORE to confirm<input value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <div className={styles.actions}><button type="button" className={`btn ${styles.danger}`} disabled={busy !== "" || typed !== "RESTORE"} onClick={() => void stageRestore(backup.name)}>{busy === "restore" ? "Preparing…" : maintenance.restartSupported ? "Restore and restart" : "Stage restore"}</button><button type="button" className="btn btn-secondary" onClick={() => { setRestoring(null); setTyped(""); }}>Cancel</button></div>
          </div>}
        </li>)}</ul>}
    </section>
  </div>;
}
