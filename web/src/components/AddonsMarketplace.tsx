"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import ModuleUpdates from "./ModuleUpdates";
import styles from "./AddonsMarketplace.module.css";

type State = "unknown" | "absent" | "stopped" | "running" | "pulling" | "starting" | "failed";
interface Addon { name: string; label: string; group: string; blurb: string; home: string; licence: string; ui: boolean; needs: string | null; state: State; port: number; autostart: boolean; error: string | null }
interface View { control: { mode: "embedded" | "external" | "off"; reason: string | null }; groups: string[]; addons: Addon[] }
interface Logs { deploy: Array<{ time: string; message: string }>; container: string[] }
const WORDS: Record<State, string> = { unknown: "Docker control is off", absent: "Not installed", stopped: "Stopped", running: "Running", pulling: "Downloading…", starting: "Starting…", failed: "Needs attention" };
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/install.sh | bash -s -- --media-manager";

/**
 * The add-on marketplace: programs people run next to a media server (Sonarr, Radarr, Seerr and the rest), each installed with one button.
 * StreamRD only asks the Docker helper; what the container is made of is fixed on the server side. Each card keeps its own log, so what
 * the installation is doing is always visible.
 */
export default function AddonsMarketplace() {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [logins, setLogins] = useState<Record<string, string>>({}), [ports, setPorts] = useState<Record<string, string>>({}), [open, setOpen] = useState<Record<string, boolean>>({}), [logs, setLogs] = useState<Record<string, Logs | null>>({});
  const mounted = useRef(true), seeded = useRef(false);
  const load = useCallback(async () => {
    try {
      const next = await api<View>("/api/admin/addons"); if (!mounted.current) return;
      setView(next); setError("");
      if (!seeded.current) { seeded.current = true; setPorts(Object.fromEntries(next.addons.map(one => [one.name, String(one.port)]))); }
    } catch { if (mounted.current) setError("The add-ons could not be loaded."); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  const working = view?.addons.some(one => one.state === "pulling" || one.state === "starting") ?? false;
  useEffect(() => { if (!working) return; const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [working, load]);
  const loadLog = useCallback(async (name: string) => {
    try { const next = await api<Logs>(`/api/admin/addons/${name}/logs?tail=120`); if (mounted.current) setLogs(current => ({ ...current, [name]: next })); } catch { /* the page keeps showing what it had */ }
  }, []);
  const control = view?.control.mode !== "off";
  useEffect(() => {
    if (!control) return; const names = Object.keys(open).filter(name => open[name]); if (!names.length) return;
    const tick = () => names.forEach(name => void loadLog(name)); tick();
    const timer = setInterval(tick, working ? 2000 : 6000); return () => clearInterval(timer);
  }, [open, control, working, loadLog]);

  async function run(key: string, action: () => Promise<string | void>) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { const message = await action(); if (message && mounted.current) setNotice(message); await load(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "That did not work. Try again."); }
    finally { if (mounted.current) setBusy(""); }
  }
  const portOf = (one: Addon) => { const value = Number(ports[one.name] ?? one.port); if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Choose a ${one.label} port between 1024 and 65535.`); return value; };
  const launch = (one: Addon) => run(`launch:${one.name}`, async () => {
    await api(`/api/admin/addons/${one.name}/launch`, { method: "POST", body: JSON.stringify(one.ui ? { port: portOf(one) } : {}) });
    setOpen(current => ({ ...current, [one.name]: true }));
    return `${one.label} is being installed. The first start downloads it, which can take a few minutes.`;
  });
  const stop = (one: Addon) => run(`stop:${one.name}`, async () => { await api(`/api/admin/addons/${one.name}/stop`, { method: "POST" }); return `${one.label} stopped.`; });
  const remove = (one: Addon) => {
    if (!window.confirm(`Remove ${one.label}? Its settings are kept, so installing it again picks up where it was.`)) return;
    void run(`remove:${one.name}`, async () => { await api(`/api/admin/addons/${one.name}`, { method: "DELETE" }); return `${one.label} removed. Its settings were kept.`; });
  };
  const showLogin = (one: Addon) => run(`login:${one.name}`, async () => {
    const found = await api<{ username: string; password: string }>(`/api/admin/addons/${one.name}/login`);
    setLogins(current => ({ ...current, [one.name]: `Sign in as ${found.username} with ${found.password}` }));
  });
  const autostart = (one: Addon, enabled: boolean) => run(`auto:${one.name}`, async () => { await api(`/api/admin/addons/${one.name}/autostart`, { method: "PUT", body: JSON.stringify({ enabled }) }); });

  if (!view) return <div className={styles.page}>{error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.small} role="status">Loading the add-ons…</p>}</div>;
  const host = typeof window === "undefined" ? "localhost" : window.location.hostname;
  return <div className={styles.page}>
    <h2 className={styles.title}>Add-ons</h2>
    <p className={styles.intro}>Add-ons are programs people usually run next to a media server. Install one with a button; it starts beside StreamRD with its own settings folder, and you can update, stop or remove it here. They are separate programs made by other people, each with its own licence; StreamRD only downloads and starts them.</p>
    {view.control.mode === "off" && <div className={styles.notice} role="note">
      <strong>One quick step, once.</strong> Installing from here needs Docker control, which is off on this server. New installs include it. On the computer that runs StreamRD, run the installer again:
      <p><code>{INSTALL_COMMAND}</code></p>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => void load()}>I ran it, check again</button>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.success} role="status">{notice}</p>}
    {view.groups.map(group => {
      const list = view.addons.filter(one => one.group === group); if (!list.length) return null;
      return <section key={group} aria-label={group}>
        <h2 className={styles.groupTitle}>{group}</h2>
        <div className={styles.grid}>
          {list.map(one => {
            const live = one.state === "pulling" || one.state === "starting", installed = ["running", "stopped"].includes(one.state);
            return <article key={one.name} className={styles.card} data-addon={one.name} aria-label={one.label}>
              <div className={styles.top}><h3>{one.label}</h3><span className={`${styles.status} ${one.state === "running" ? styles.running : one.state === "failed" ? styles.failed : ""}`} role="status" aria-label={`${one.label} status`}>{WORDS[one.state]}</span></div>
              <p className={styles.blurb}>{one.blurb}</p>
              {one.needs && <p className={styles.small}>Works with: {one.needs}.</p>}
              <p className={styles.small}>{one.licence} · <a href={one.home} target="_blank" rel="noreferrer">Website</a></p>
              {one.state === "failed" && one.error && <p className={styles.error} role="alert">{one.error}</p>}
              {one.ui && !installed && !live && <label className={styles.field}>{one.label} port<input type="number" inputMode="numeric" min={1024} max={65535} value={ports[one.name] ?? String(one.port)} onChange={event => setPorts(current => ({ ...current, [one.name]: event.target.value }))} /></label>}
              <div className={styles.row}>
                {!installed && <button type="button" className="btn btn-sm" disabled={Boolean(busy) || live || !control} onClick={() => void launch(one)}>{busy === `launch:${one.name}` || live ? "Installing…" : one.state === "failed" ? "Try again" : "Install"}</button>}
                {one.state === "stopped" && <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => void launch(one)}>Start</button>}
                {one.state === "running" && one.ui && <a className="btn btn-sm" href={`http://${host}:${one.port}`} target="_blank" rel="noreferrer">Open {one.label}</a>}
                {one.state === "running" && <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => void stop(one)}>Stop</button>}
                {(installed || one.state === "failed") && <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => remove(one)}>Remove</button>}
              </div>
              {one.state === "running" && ["sonarr", "radarr", "lidarr", "prowlarr"].includes(one.name) && <div>
                <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => void showLogin(one)}>Show login</button>
                {logins[one.name] && <p className={styles.small} role="status"><code>{logins[one.name]}</code></p>}
              </div>}
              {installed && <label className={styles.check}><input type="checkbox" checked={one.autostart} disabled={Boolean(busy)} onChange={event => void autostart(one, event.target.checked)} />
                <span>Start {one.label} again when this machine restarts</span></label>}
              {installed && <ModuleUpdates only={[one.name]} compact />}
              {control && one.state !== "absent" && <div>
                <button type="button" className="btn btn-sm btn-secondary" aria-expanded={Boolean(open[one.name])} onClick={() => setOpen(current => ({ ...current, [one.name]: !current[one.name] }))}>{open[one.name] ? "Hide log" : "Show log"}</button>
                {open[one.name] && <pre className={styles.log} role="log" aria-label={`${one.label} log`} tabIndex={0}>{logs[one.name] === undefined || logs[one.name] === null ? "Loading…" : [...logs[one.name]!.deploy.map(entry => `${entry.time.slice(11, 19)}  ${entry.message}`), ...logs[one.name]!.container].join("\n") || "Nothing to show yet."}</pre>}
              </div>}
            </article>;
          })}
        </div>
      </section>;
    })}
  </div>;
}
