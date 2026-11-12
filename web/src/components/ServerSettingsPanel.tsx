"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

type Name = "transcode" | "transcodeVideo" | "transcodeMax" | "transcodeAllowPrivateHosts" | "linkHealth" | "updateCheck" | "requestsAutoApprove";
type Source = "saved" | "environment" | "default";
interface View { settings: Record<Name, boolean | number>; sources: Record<Name, Source> }

const SWITCHES: Array<{ name: Name; conversion?: boolean; label: string; help: string }> = [
  { name: "transcode", conversion: true, label: "Convert files a browser cannot play", help: "MKV, DTS, HEVC and similar are converted while they are watched. Off: every file is played as it is, and the browser plays what it can." },
  { name: "transcodeVideo", conversion: true, label: "Also convert the picture when a file needs it", help: "The heaviest conversion, limited to 1080p. Off: only repackaging and audio conversion are done." },
  { name: "transcodeAllowPrivateHosts", conversion: true, label: "Let the server read media links on its own network", help: "Only for a source at a local address, such as a NAS. Leave it off for debrid links." },
  { name: "requestsAutoApprove", label: "Approve requests automatically", help: "A request is approved when it arrives: the server picks the best release and sends it to your cloud account. Needs an indexer (Admin → Requests), a cloud account and a library. Off: every request waits for an administrator." },
  { name: "linkHealth", label: "Check in the background that links still work", help: "A few titles a minute. A link that stops working is marked, and a replacement is requested." },
  { name: "updateCheck", label: "Check for new versions", help: "Asks the project's release page whether a newer version exists. Nothing about this server is sent." },
];
const WHERE: Record<Source, string> = { saved: "chosen here", environment: "set in the server's environment", default: "the default" };

/**
 * Settings that used to be environment variables, changed from this page and in force at once. `conversion` shows the playback
 * conversion settings, which only StreamRD has.
 */
export default function ServerSettingsPanel({ conversion = false }: { conversion?: boolean }) {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [max, setMax] = useState("");
  const mounted = useRef(true);
  const load = useCallback(async () => {
    try { const next = await api<View>("/api/admin/system/settings"); if (!mounted.current) return; setView(next); setMax(String(next.settings.transcodeMax)); setError(""); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "The server settings could not be loaded."); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  async function save(change: Partial<Record<Name, boolean | number | null>>, said: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api<View>("/api/admin/system/settings", { method: "PUT", body: JSON.stringify(change) }); if (!mounted.current) return; setView(next); setMax(String(next.settings.transcodeMax)); setNotice(said); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "That could not be saved. Try again."); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!view) return <div className="card" style={{ marginBottom: 20 }}><h2 style={{ fontSize: 16, marginBottom: 8 }}>Server settings</h2><p className={error ? "error-text" : "dim"} role={error ? "alert" : "status"}>{error || "Loading…"}</p></div>;
  const origin = (name: Name) => <small className="dim" style={{ display: "block" }}>Now: {WHERE[view.sources[name]]}.{view.sources[name] === "saved" && <> <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void save({ [name]: null }, "Back to the default.")}>Use the default</button></>}</small>;
  const count = Number(max), countValid = Number.isInteger(count) && count >= 1 && count <= 8;
  return <div className="card" style={{ marginBottom: 20 }}>
    <h2 style={{ fontSize: 16, marginBottom: 6 }}>Server settings</h2>
    <p className="dim" style={{ fontSize: 13, marginBottom: 14 }}>These take effect as soon as you change them. Nothing needs to be edited on the server, and nothing needs a restart.</p>
    <div style={{ display: "grid", gap: 14 }}>
      {SWITCHES.filter(entry => conversion || !entry.conversion).map(entry => <div key={entry.name}>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
          <input type="checkbox" style={{ width: 16, height: 16, minHeight: 16, padding: 0, margin: "3px 0 0", flex: "none" }} checked={view.settings[entry.name] === true} disabled={busy} onChange={event => void save({ [entry.name]: event.target.checked }, `${entry.label}: ${event.target.checked ? "on" : "off"}.`)} />
          <span><strong>{entry.label}</strong><br /><span className="dim" style={{ fontSize: 13 }}>{entry.help}</span>{origin(entry.name)}</span>
        </label>
      </div>)}
      {conversion && <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="conversions-at-once">Videos converted at once (1 to 8)</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input id="conversions-at-once" type="number" inputMode="numeric" min={1} max={8} value={max} disabled={busy} onChange={event => setMax(event.target.value)} style={{ width: 90 }} />
          <button type="button" className="btn btn-secondary" disabled={busy || !countValid || count === view.settings.transcodeMax} onClick={() => void save({ transcodeMax: count }, `Up to ${count} ${count === 1 ? "video is" : "videos are"} converted at once.`)}>Save</button>
        </div>
        <span className="dim" style={{ fontSize: 13 }}>More viewers of converted files at the same moment get a short “try again”. Each conversion uses a processor core or more.</span>
        {origin("transcodeMax")}
      </div>}
    </div>
    {notice && <p className="ok-text" role="status" style={{ marginTop: 12 }}>{notice}</p>}
    {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>{error}</p>}
  </div>;
}
