"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import ModuleUpdates from "./ModuleUpdates";
import styles from "./AccountScanPanel.module.css";

type Name = "jellyfin" | "plex";
type State = "unknown" | "absent" | "stopped" | "running" | "pulling" | "starting" | "failed";
interface Server { port: number; state: State; error?: string; secretHint: string | null; autostart: boolean }
interface Logs { deploy: Array<{ time: string; message: string }>; container: string[] }
interface View { manager: { available: boolean; mode?: "embedded" | "external" | "off"; reason?: "no-socket" | "not-root" | "disabled" | "unset" | null; shared?: boolean }; servers: Record<Name, Server> }
// The one command that turns Docker control on for an existing install: the installer, run again.
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/install.sh | bash -s -- --media-manager";

const COPY: Record<Name, { label: string; secret: string; secretHelp: string; port: number; path: string }> = {
  jellyfin: { label: "Jellyfin", secret: "Jellyfin API key", secretHelp: "Optional. Create one in Jellyfin under Dashboard, API Keys. It lets StreamRD ask Jellyfin to rescan your libraries.", port: 8096, path: "" },
  plex: { label: "Plex", secret: "Plex token", secretHelp: "Optional. Your Plex token lets StreamRD ask Plex to rescan your libraries. It is stored encrypted and never shown again.", port: 32400, path: "/web" },
};
const WORDS: Record<State, string> = { unknown: "Docker control is off", absent: "Not started", stopped: "Stopped", running: "Running", pulling: "Downloading the image…", starting: "Starting…", failed: "Needs attention" };

/** Onboarding for Plex and Jellyfin: where to put the tokens, and (with Docker control on) a button that starts the container next to StreamRD. */
export default function MediaServersPanel() {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [ports, setPorts] = useState<Record<Name, string>>({ jellyfin: "", plex: "" }), [secrets, setSecrets] = useState<Record<Name, string>>({ jellyfin: "", plex: "" }), [claim, setClaim] = useState("");
  const [open, setOpen] = useState<Record<Name, boolean>>({ jellyfin: false, plex: false }), [logs, setLogs] = useState<Record<Name, Logs | null>>({ jellyfin: null, plex: null }), [logError, setLogError] = useState<Record<Name, string>>({ jellyfin: "", plex: "" });
  const mounted = useRef(true), seeded = useRef(false), panes = useRef<Record<Name, HTMLPreElement | null>>({ jellyfin: null, plex: null });
  const load = useCallback(async () => {
    try {
      const next = await api<View>("/api/admin/media-servers");
      if (!mounted.current) return;
      setView(next); setError("");
      if (!seeded.current) { seeded.current = true; setPorts({ jellyfin: String(next.servers.jellyfin.port), plex: String(next.servers.plex.port) }); }
    } catch { if (mounted.current) setError("The media server settings could not be loaded."); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  const working = view && Object.values(view.servers).some(server => server.state === "pulling" || server.state === "starting");
  useEffect(() => { if (!working) return; const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [working, load]);
  // The deploy log: what was done to start the server (image download, container start) and the server's own output, live while it is open.
  const loadLogs = useCallback(async (name: Name) => {
    try { const next = await api<Logs>(`/api/admin/media-servers/${name}/logs?tail=150`); if (!mounted.current) return; setLogs(current => ({ ...current, [name]: next })); setLogError(current => ({ ...current, [name]: "" })); }
    catch (reason) { if (mounted.current) setLogError(current => ({ ...current, [name]: reason instanceof Error ? reason.message : "The log could not be loaded." })); }
  }, []);
  const available = view?.manager.available ?? false;
  useEffect(() => {
    if (!available) return;
    const names = (["jellyfin", "plex"] as Name[]).filter(name => open[name]); if (!names.length) return;
    const tick = () => names.forEach(name => void loadLogs(name)); tick();
    const timer = setInterval(tick, working ? 2000 : 6000); return () => clearInterval(timer);
  }, [open, available, working, loadLogs]);
  useEffect(() => { for (const name of ["jellyfin", "plex"] as Name[]) { const pane = panes.current[name]; if (pane) pane.scrollTop = pane.scrollHeight; } }, [logs]);

  async function run(key: string, action: () => Promise<string | void>) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { const message = await action(); if (message && mounted.current) setNotice(message); await load(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "That did not work. Try again."); }
    finally { if (mounted.current) setBusy(""); }
  }
  const portOf = (name: Name) => { const value = Number(ports[name]); if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Choose a ${COPY[name].label} port between 1024 and 65535.`); return value; };
  const save = (name: Name) => api("/api/admin/media-servers", { method: "PUT", body: JSON.stringify({ [name]: { port: portOf(name), ...(secrets[name].trim() ? { secret: secrets[name].trim() } : {}) } }) }).then(() => { setSecrets(current => ({ ...current, [name]: "" })); });
  const launch = (name: Name) => run(`launch-${name}`, async () => {
    await save(name);
    await api(`/api/admin/media-servers/${name}/launch`, { method: "POST", body: JSON.stringify({ port: portOf(name), ...(name === "plex" && claim.trim() ? { claim: claim.trim() } : {}) }) });
    if (name === "plex") setClaim("");
    setOpen(current => ({ ...current, [name]: true })); // show the deploy log as soon as it starts
    return `${COPY[name].label} is being started. The first start downloads the image, which can take a few minutes.`;
  });

  if (!view) return error ? <p role="alert">{error}</p> : null;
  const url = (name: Name) => `http://${typeof window === "undefined" ? "localhost" : window.location.hostname}:${view.servers[name].port}${COPY[name].path}`;
  return <section className={styles.panel} id="media-servers" aria-label="Media servers">
    <header className={styles.header}><div><p>ONBOARDING · MEDIA SERVER</p><h2>Run Plex or Jellyfin next to StreamRD.</h2>
      <p>Pick a server, enter its details and launch it. It starts beside StreamRD with your libraries and downloads already mapped (read-only); you only add the libraries inside Plex or Jellyfin.</p></div></header>
    {!view.manager.available && <div role="note" style={{ margin: "12px 0", padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(255,138,31,.45)", background: "rgba(255,138,31,.08)", display: "grid", gap: 10 }}>
      {view.manager.mode && view.manager.mode !== "off" ? <>
        <div><strong>The helper that talks to Docker is not answering.</strong> It starts again by itself; this usually lasts under a minute. You can still save tokens and test or rescan a server.</div>
        <div><button type="button" className="btn btn-sm btn-secondary" onClick={() => void load()}>Check again</button></div>
      </> : view.manager.reason === "not-root" ? <>
        <div><strong>One line to add.</strong> Docker&apos;s socket is shared with StreamRD&apos;s container, but the container does not start as root, so the small helper that would use it is not started. Add <code>user: &quot;0:0&quot;</code> to the StreamRD service and recreate the container (StreamRD itself still runs as an ordinary user), or run the installer again, which does it for you.</div>
        <div><button type="button" className="btn btn-sm btn-secondary" onClick={() => void load()}>Check again</button></div>
      </> : view.manager.reason === "disabled" ? <>
        <div><strong>Turned off on this server.</strong> Starting Plex and Jellyfin from here is switched off with <code>DOCKER_CONTROL=false</code>. Remove that setting and recreate the container to use it.</div>
      </> : <>
        <div><strong>One quick step, once.</strong> New installs already include it. This server runs without access to Docker, so it cannot start Plex or Jellyfin for you. On the computer that runs StreamRD, run the installer again:</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <code style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(0,0,0,.45)", overflowWrap: "anywhere" }}>{INSTALL_COMMAND}</code>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => { void navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => setNotice("Command copied."), () => setNotice("Your browser blocked copying; select the command above.")); }}>Copy command</button>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void load()}>I ran it — check again</button>
        </div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>It keeps your settings and data and takes about a minute (add <code>--dir</code> and your folder if StreamRD is not in <code>~/streamrd</code>). After that, Launch works from this page, and so do the Update and Restart buttons in Admin → System. You can still save tokens and test or rescan a server you started another way.</div>
      </>}
    </div>}
    {error && <div className={styles.error} role="alert"><p>{error}</p></div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", alignItems: "start", marginTop: 12 }}>
      {(["jellyfin", "plex"] as Name[]).map(name => {
        const server = view.servers[name], copy = COPY[name], live = server.state === "pulling" || server.state === "starting";
        return <article key={name} aria-label={`${copy.label} media server`} style={{ border: "1px solid rgba(255,255,255,.14)", borderRadius: 16, padding: 16, display: "grid", alignContent: "start", gap: 10, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><h3 style={{ margin: 0 }}>{copy.label}</h3><span role="status" aria-label={`${copy.label} status`}>{WORDS[server.state]}</span></div>
          {server.state === "failed" && server.error && <p role="alert" style={{ margin: 0 }}>{server.error}</p>}
          <label style={{ display: "grid", gap: 4 }}>{copy.label} port<input type="number" inputMode="numeric" min={1024} max={65535} value={ports[name]} onChange={event => setPorts(current => ({ ...current, [name]: event.target.value }))} /></label>
          <label style={{ display: "grid", gap: 4 }}>{copy.secret}<input type="password" autoComplete="off" spellCheck={false} maxLength={500} value={secrets[name]} placeholder={server.secretHint ? `Saved (${server.secretHint})` : "Paste it here"} onChange={event => setSecrets(current => ({ ...current, [name]: event.target.value }))} /><small style={{ opacity: 0.75 }}>{copy.secretHelp}</small></label>
          {name === "plex" && <label style={{ display: "grid", gap: 4 }}>Plex claim token<input type="text" autoComplete="off" spellCheck={false} maxLength={120} value={claim} placeholder="claim-…" onChange={event => setClaim(event.target.value)} /><small style={{ opacity: 0.75 }}>Optional. Get it at plex.tv/claim; it is valid for 4 minutes, used once to link the server to your Plex account, and not stored.</small></label>}
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" style={{ width: 16, height: 16, minHeight: 16, padding: 0, margin: "3px 0 0", flex: "none" }} checked={server.autostart} disabled={Boolean(busy)} onChange={event => { const enabled = event.target.checked; void run(`autostart-${name}`, async () => { await api(`/api/admin/media-servers/${name}/autostart`, { method: "PUT", body: JSON.stringify({ enabled }) }); return enabled ? `${copy.label} will start again by itself after this machine restarts.` : `${copy.label} will stay stopped after this machine restarts, until you launch it here.`; }); }} />
            <span>Start {copy.label} again by itself when this machine restarts<br /><small style={{ opacity: 0.75 }}>A server you stopped here stays stopped either way.</small></span>
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="btn" disabled={Boolean(busy) || live || !view.manager.available} onClick={() => void launch(name)}>{busy === `launch-${name}` ? "Starting…" : server.state === "running" ? `Relaunch ${copy.label}` : `Launch ${copy.label}`}</button>
            <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void run(`save-${name}`, async () => { await save(name); return `${copy.label} settings saved.`; })}>Save settings</button>
            {server.state === "running" && <a className="btn btn-secondary" href={url(name)} target="_blank" rel="noreferrer">Open {copy.label}</a>}
            {(server.state === "running" || server.state === "stopped" || server.state === "failed") && <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void run(`stop-${name}`, async () => { await api(`/api/admin/media-servers/${name}/${server.state === "running" ? "stop" : ""}`.replace(/\/$/, ""), { method: server.state === "running" ? "POST" : "DELETE" }); return server.state === "running" ? `${copy.label} stopped.` : `${copy.label} removed. Its settings are kept.`; })}>{server.state === "running" ? "Stop" : "Remove"}</button>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => void run(`test-${name}`, async () => { const result = await api<{ reachable: boolean; accepted: boolean | null }>(`/api/admin/media-servers/${name}/test`, { method: "POST", body: "{}" }); return !result.reachable ? `${copy.label} could not be reached. Is it running?` : result.accepted === false ? `${copy.label} is running but did not accept the saved ${copy.secret.toLowerCase()}.` : result.accepted ? `${copy.label} is running and accepted the saved ${copy.secret.toLowerCase()}.` : `${copy.label} is running. Save a ${copy.secret.toLowerCase()} to let StreamRD rescan its libraries.`; })}>Test connection</button>
            {server.secretHint && <button type="button" className="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => void run(`refresh-${name}`, async () => { const result = await api<{ refreshed: number }>(`/api/admin/media-servers/${name}/refresh`, { method: "POST", body: "{}" }); return result.refreshed ? `${copy.label} was asked to rescan ${result.refreshed === 1 && name === "jellyfin" ? "all its libraries" : `${result.refreshed} ${result.refreshed === 1 ? "library" : "libraries"}`}.` : `${copy.label} has no library under /library yet. Add Movies (/library/streamrd/Movies) first.`; })}>Rescan libraries</button>}
          </div>
          {view.manager.available && <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn btn-sm btn-secondary" aria-expanded={open[name]} onClick={() => setOpen(current => ({ ...current, [name]: !current[name] }))}>{open[name] ? "Hide deploy log" : "Show deploy log"}</button>
              {open[name] && <button type="button" className="btn btn-sm btn-secondary" onClick={() => { const text = [...(logs[name]?.deploy ?? []).map(entry => `${entry.time.slice(11, 19)}  ${entry.message}`), ...(logs[name]?.container ?? [])].join("\n"); void navigator.clipboard?.writeText(text).then(() => setNotice("Log copied.")).catch(() => setError("The log could not be copied.")); }}>Copy log</button>}
            </div>
            {open[name] && <>
              {logError[name] && <p role="alert" style={{ margin: 0 }}>{logError[name]}</p>}
              <pre ref={element => { panes.current[name] = element; }} role="log" aria-live="polite" aria-label={`${copy.label} deploy log`} tabIndex={0} style={{ margin: 0, padding: 12, maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.5, borderRadius: 10, background: "rgba(0,0,0,.45)", border: "1px solid rgba(255,255,255,.12)" }}>
                {logs[name] === null ? "Loading…" : (logs[name]!.deploy.length || logs[name]!.container.length) ? <>{logs[name]!.deploy.map((entry, index) => <span key={`d${index}`}><span style={{ opacity: 0.6 }}>{entry.time.slice(11, 19)}</span>{"  "}{entry.message}{"\n"}</span>)}{logs[name]!.container.length > 0 && <span style={{ opacity: 0.6 }}>{"\n— output from the container —\n"}</span>}{logs[name]!.container.map((line, index) => <span key={`c${index}`}>{line}{"\n"}</span>)}</> : "Nothing yet. Press Launch and the steps appear here."}
              </pre>
            </>}
          </div>}
        </article>;
      })}
    </div>
    <ModuleUpdates only={["jellyfin", "plex"]} compact />
    <p style={{ opacity: 0.75, fontSize: 13 }}>In Plex or Jellyfin add Movies at <code>/library/streamrd/Movies</code> and TV Shows at <code>/library/streamrd/TV Shows</code>. Plex discovery on your network is limited by Docker&rsquo;s bridge network; the Plex and Jellyfin guide explains host networking.</p>
  </section>;
}
