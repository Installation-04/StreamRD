"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import styles from "./SystemMaintenance.module.css";

interface Mod {
  name: string; label: string; what: string; state: string; version: string | null; built: string | null;
  update: { state: "running" | "current" | "available" | "updated" | "failed"; apply: boolean; step: string; error: string } | null;
  updateAvailable: boolean; availableVersion: string | null; checkedAt: string | null; updatedAt: string | null; auto: boolean;
}
interface View { control: { mode: "embedded" | "external" | "off"; reason: string | null }; window: { from: number; to: number; timezone: string }; modules: Mod[] }
const when = (value: string | null) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : "";
const hours = (view: View) => `${String(view.window.from).padStart(2, "0")}:00 to ${String(view.window.to).padStart(2, "0")}:00`;

/** What a module is doing about updates, in a sentence: the thing the administrator reads first. */
function status(one: Mod): { text: string; tone: "ok" | "warn" | "plain" } {
  const update = one.update;
  if (update?.state === "running") return { text: `${update.apply ? "Updating" : "Checking"}… ${update.step}`.trim(), tone: "plain" };
  if (["pulling", "starting"].includes(one.state)) return { text: "Starting…", tone: "plain" };
  if (update?.state === "failed") return { text: update.error || "The update did not finish.", tone: "warn" };
  if (one.updateAvailable) return { text: `Update available${one.availableVersion ? `: ${one.availableVersion}` : ""}`, tone: "warn" };
  if (one.checkedAt) return { text: "Up to date", tone: "ok" };
  return { text: "Not checked yet", tone: "plain" };
}

/**
 * The programs StreamRD runs next to itself (Prowlarr, Jellyfin, Plex) are updated here, whenever a newer version exists: Check looks, Update
 * restarts the module on the newer version, and each can be left to update itself at night. `compact` is the form that sits inside a
 * module's own card; `only` limits the list to some modules.
 */
export default function ModuleUpdates({ only, compact = false }: { only?: string[]; compact?: boolean }) {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const mounted = useRef(true);
  const load = useCallback(async () => {
    try { const next = await api<View>("/api/admin/modules"); if (mounted.current) { setView(next); setError(""); } }
    catch { if (mounted.current) setError("The modules could not be loaded."); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  const modules = (view?.modules ?? []).filter(one => (!only || only.includes(one.name)) && !["absent", "unknown"].includes(one.state));
  const working = modules.some(one => one.update?.state === "running" || ["pulling", "starting"].includes(one.state));
  useEffect(() => { if (!working) return; const timer = setInterval(() => void load(), 2500); return () => clearInterval(timer); }, [working, load]);

  async function run(key: string, route: string, init: RequestInit, done?: string) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { const next = await api<View>(route, init); if (mounted.current) { setView(next); if (done) setNotice(done); } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "That did not work. Try again."); }
    finally { if (mounted.current) setBusy(""); }
  }
  const check = (one: Mod) => run(`check:${one.name}`, `/api/admin/modules/${one.name}/check`, { method: "POST" });
  const update = (one: Mod) => {
    if (!window.confirm(`Update ${one.label} now? It restarts for a minute${one.what === "media server" ? ", and anything it is playing stops" : ""}. Its settings and library are kept, and the previous version is put back if the new one does not start.`)) return;
    void run(`update:${one.name}`, `/api/admin/modules/${one.name}/update`, { method: "POST" }, `${one.label} is being updated. This page follows it.`);
  };
  const auto = (one: Mod, enabled: boolean) => run(`auto:${one.name}`, `/api/admin/modules/${one.name}/auto`, { method: "PUT", body: JSON.stringify({ enabled }) });

  if (compact && (!view || view.control.mode === "off" || !modules.length)) return null;
  const rows = modules.map(one => {
    const now = status(one), running = one.state === "running", busyHere = busy !== "" || one.update?.state === "running";
    const version = one.version ? `Version ${one.version}` : one.built ? `Image built ${when(one.built)}` : "Version not reported by the image";
    return <li key={one.name} className={styles.row} data-module={one.name}>
      <div>
        <div className={styles.name}>{one.label}{!compact && <> <span className={styles.tag}>{one.what}</span></>}</div>
        <div className={styles.meta}>
          <span>{version}</span>
          <span className={now.tone === "ok" ? styles.ok : now.tone === "warn" ? styles.warn : undefined} role="status">{now.text}</span>
          {one.checkedAt && <span>Checked {when(one.checkedAt)}</span>}
          {one.updatedAt && <span>Updated {when(one.updatedAt)}</span>}
        </div>
      </div>
      <div className={styles.rowActions}>
        <button type="button" className="btn btn-secondary" disabled={busyHere} aria-label={`Check ${one.label} for updates`} onClick={() => void check(one)}>{busy === `check:${one.name}` ? "Checking…" : "Check for updates"}</button>
        <button type="button" className={one.updateAvailable ? "btn" : "btn btn-secondary"} disabled={busyHere || !running} title={running ? undefined : `Start ${one.label} before updating it`} aria-label={`Update ${one.label} now`} onClick={() => update(one)}>Update now</button>
      </div>
      {!compact && view && <div className={styles.confirm}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={one.auto} disabled={busy !== ""} onChange={event => void auto(one, event.target.checked)} />
          Update {one.label} by itself at night ({hours(view)}, {view.window.timezone})</label>
      </div>}
    </li>;
  });
  const messages = <>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.success} role="status">{notice}</p>}
  </>;
  if (compact) return <div role="group" aria-label="Updates">{messages}<ul className={styles.list} aria-label="Module updates">{rows}</ul></div>;
  return <section className={styles.panel} aria-labelledby="modules-heading">
    <div className={styles.heading}><div><p className={styles.eyebrow}>ADD-ONS</p><h3 id="modules-heading">Prowlarr, Jellyfin and Plex</h3></div></div>
    <p className={styles.copy}>These programs have their own releases, so they are updated here and not only when StreamRD is. Check looks for a newer version and changes nothing; Update restarts the module on the newer one, keeps its settings, and puts the previous version back if the new one does not start. Updating at night is off until you turn it on, because an update stops anything a media server is playing.</p>
    {messages}
    {!view ? <p className={styles.empty} role="status">Loading the modules…</p>
      : view.control.mode === "off" ? <p className={styles.notice}>Updating these from here needs Docker control, which is off on this server. Turn it on by running the installer again, or update them with Docker as before.</p>
      : !modules.length ? <p className={styles.empty}>No add-on is running yet. Prowlarr, Jellyfin and Plex show up here once they are started.</p>
      : <ul className={styles.list} aria-label="Module updates">{rows}</ul>}
  </section>;
}
