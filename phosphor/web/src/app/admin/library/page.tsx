"use client";
import { useCallback, useEffect, useState } from "react";
import { del, get, post } from "@/lib/api";
type Entry = { id: string; media: { name: string; sourcePath: string }; libraryPath: string; sourceAvailable: boolean; linked: boolean };
type Status = { enabled: boolean; sourceRoot?: string; exportRoot?: string; entries: Entry[] };
export default function LibraryPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [name, setName] = useState(""), [year, setYear] = useState("");
  const [type, setType] = useState("movie"), [season, setSeason] = useState("1"), [episode, setEpisode] = useState("1");
  const [source, setSource] = useState(""), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const load = useCallback(async () => { setStatus(await get<Status>("/api/admin/library")); }, []);
  useEffect(() => { void load().catch(e => setError((e as Error).message)); }, [load]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <h2 style={{ marginBottom: 12 }}>Plex / Jellyfin library</h2>
    <p className="dim" style={{ marginBottom: 16 }}>Export mounted video files as scanner-friendly symlinks. Your normal stream URLs keep working without a mount.</p>
    {error && <p className="error-text" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {status && !status.enabled && <div className="card" style={{ padding: 20 }}>
      <h3>Optional mount is not configured</h3>
      <p style={{ marginTop: 12 }}>Mount your media (for example with rclone or Zurg), then set MEDIA_SOURCE_ROOT and MEDIA_LIBRARY_ROOT to separate absolute directories on the backend. Give Plex and Jellyfin the same source path and the exported Movies / TV Shows folders.</p>
      <p style={{ marginTop: 12 }}>See <a href="https://github.com/Installation-04/StreamRD/wiki/Plex-and-Jellyfin" target="_blank" rel="noreferrer">the Plex and Jellyfin setup guide</a> for Docker mounts and scan settings.</p>
    </div>}
    {status?.enabled && <>
      <div className="card" style={{ padding: 16, margin: "16px 0", overflowWrap: "anywhere" }}>
        <p>Media mount: <code>{status.sourceRoot}</code></p><p>Scanner library: <code>{status.exportRoot}</code></p>
        <p className="dim" style={{ marginTop: 8 }}>Add Movies as a movie library and TV Shows as a series library. Both scanners must also see symlink targets at the same absolute mount path.</p>
      </div>
      <form className="card" style={{ padding: 20, marginBottom: 20 }} onSubmit={e => { e.preventDefault(); void perform(async () => {
        await post("/api/admin/library/entries", { name, type, sourcePath: source, ...(year ? { year: Number(year) } : {}), ...(type === "episode" ? { season: Number(season), episode: Number(episode) } : {}) });
        setMessage("Symlink exported. Scan the library in Plex or Jellyfin.");
      }); }}>
        <h3 style={{ marginBottom: 16 }}>Export a mounted file</h3>
        <div className="field"><label htmlFor="media-name">Movie or series name</label><input id="media-name" required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div className="field"><label htmlFor="media-type">Type</label><select id="media-type" value={type} onChange={e => setType(e.target.value)}><option value="movie">Movie</option><option value="episode">TV episode</option></select></div>
          <div className="field"><label htmlFor="media-year">Year (optional)</label><input id="media-year" type="number" min={1800} max={2200} value={year} onChange={e => setYear(e.target.value)} /></div>
          {type === "episode" && <>
            <div className="field"><label htmlFor="media-season">Season</label><input id="media-season" type="number" required min={0} max={999} value={season} onChange={e => setSeason(e.target.value)} /></div>
            <div className="field"><label htmlFor="media-episode">Episode</label><input id="media-episode" type="number" required min={1} max={9999} value={episode} onChange={e => setEpisode(e.target.value)} /></div>
          </>}
        </div>
        <div className="field"><label htmlFor="media-source">Video path relative to the media mount</label><input id="media-source" required placeholder="movies/Example (2024)/Example.mkv" value={source} onChange={e => setSource(e.target.value)} /></div>
        <button className="btn" disabled={busy}>Export symlink</button>
      </form>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button className="btn" disabled={busy} onClick={() => void perform(async () => {
          const result = await post<{ results: { status: string }[] }>("/api/admin/library/repair");
          setMessage(`Checked ${result.results.length} exports: ${result.results.filter(r => r.status === "repaired").length} repaired, ${result.results.filter(r => r.status === "unavailable" || r.status === "conflict").length} need attention.`);
        })}>Check / repair links</button>
        <button className="btn" disabled={busy} onClick={() => void perform(async () => {})}>Refresh status</button>
      </div>
      {status.entries.length === 0 && <p className="dim">No exported files yet.</p>}
      {status.entries.map(entry => <div className="card" key={entry.id} style={{ padding: 16, marginBottom: 12, overflowWrap: "anywhere" }}>
        <strong>{entry.media.name}</strong><p><code>{entry.libraryPath}</code></p><p className="dim">Source: {entry.media.sourcePath}</p>
        <p style={{ margin: "8px 0" }}>{!entry.sourceAvailable ? "Source unavailable — check the mount" : entry.linked ? "Ready to scan" : "Link missing or changed — check / repair"}</p>
        <button className="btn btn-sm" disabled={busy} onClick={() => {
          if (window.confirm(`Remove the exported link for ${entry.media.name}? Source media will be kept.`)) void perform(async () => { await del(`/api/admin/library/entries/${entry.id}`); setMessage("Export removed. Source media was kept."); });
        }}>Remove link</button>
      </div>)}
    </>}
  </>;
}
