"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMedia, AccountPlayResult, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import { sourceType } from "@/lib/playback";
import PlaybackHelp from "@/components/PlaybackHelp";
import { Icon } from "@/components/Icon";
import styles from "./SharedPlayer.module.css";

type Files = NonNullable<AccountPlayResult["files"]>;
const HIDE_MS = 3200, NEXT_SECONDS = 10;
const clock = (seconds: number) => { const total = Math.max(0, Math.floor(seconds)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60; return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`; };

/**
 * The full-page player, in the style of Plex: a black page with the video, a title bar that fades away while you watch, keyboard shortcuts,
 * resume, a file/episode chooser, "Up next" for the next file of a pack, and a hand-off to VLC or mpv when a browser cannot play a file.
 * Playback is resolved by the server's own account; nothing is transcoded.
 */
export default function SharedPlayer() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>(), { user, loading: authLoading } = useAuth(), router = useRouter();
  const [item, setItem] = useState<AccountMedia | null>(null), [loadError, setLoadError] = useState(""), [busy, setBusy] = useState(true), [playError, setPlayError] = useState(""), [pending, setPending] = useState<number | null>(null);
  const [files, setFiles] = useState<Files>([]), [current, setCurrent] = useState<string | null>(null), [choosing, setChoosing] = useState(false), [search, setSearch] = useState(""), [limit, setLimit] = useState(50);
  const [stream, setStream] = useState<NonNullable<AccountPlayResult["stream"]> | null>(null), [videoError, setVideoError] = useState(false), [ended, setEnded] = useState(false), [countdown, setCountdown] = useState<number | null>(null);
  const [visible, setVisible] = useState(true), [paused, setPaused] = useState(true), [position, setPosition] = useState({ at: 0, total: 0 });
  const mounted = useRef(false), request = useRef<AbortController | null>(null), root = useRef<HTMLDivElement | null>(null), video = useRef<HTMLVideoElement | null>(null), idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const session = useRef<{ id: string; sequence: number; sentAt: number; resume: number; position: number; duration: number } | null>(null);
  const detail = `/shared-libraries/${encodeURIComponent(id)}/${encodeURIComponent(itemId)}`;

  const saveProgress = useCallback((force = false) => {
    const element = video.current, now = session.current; if (!now) return;
    if (element && Number.isFinite(element.duration) && element.duration > 0) { now.position = Math.min(element.currentTime, element.duration); now.duration = element.duration; }
    if (now.duration <= 0 || now.position <= 0) return;
    const at = Date.now(); if (!force && at - now.sentAt < 15000) return;
    now.sentAt = at; now.sequence += 1;
    void api(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/progress`, { method: "PUT", keepalive: true, body: JSON.stringify({ sessionId: now.id, sequence: now.sequence, positionSeconds: now.position, durationSeconds: now.duration }) }).catch(() => undefined);
  }, [id, itemId]);
  const leave = useCallback(() => { video.current?.pause(); saveProgress(true); session.current = null; if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); router.push(detail); }, [saveProgress, router, detail]);

  const play = useCallback(async (fileToken?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setPlayError(""); setPending(null); setVideoError(false); setEnded(false); setCountdown(null); video.current?.pause(); setStream(null);
    try {
      const result = await api<AccountPlayResult>(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/play`, { method: "POST", signal: controller.signal, body: JSON.stringify(fileToken ? { fileToken } : {}) });
      if (controller.signal.aborted || !mounted.current) return;
      if (result.pending) { setPending(Math.max(0, Math.min(100, result.progress ?? 0))); return; }
      if (result.selectionRequired && Array.isArray(result.files) && result.files.length) { setFiles(result.files); setChoosing(true); setSearch(""); setLimit(50); return; }
      const url = result.stream ? safeMediaUrl(result.stream.url) : null;
      if (result.stream && url) {
        session.current = result.progressSessionId ? { id: result.progressSessionId, sequence: 0, sentAt: Date.now(), resume: result.resumeSeconds ?? 0, position: 0, duration: 0 } : null;
        setStream({ ...result.stream, url }); setChoosing(false); setCurrent(fileToken ?? null); return;
      }
      throw new Error("No playable video was returned. The torrent may need a video file selected by the server owner.");
    } catch (reason) { if (!controller.signal.aborted && mounted.current) setPlayError(reason instanceof Error ? reason.message : "The stream could not be resolved. Try again."); }
    finally { if (!controller.signal.aborted && mounted.current) setBusy(false); }
  }, [id, itemId]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
    if (!user) return;
    const controller = new AbortController();
    api<{ item: AccountMedia }>(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) { setItem(response.item); void play(); } })
      .catch(reason => { if (!controller.signal.aborted) { setLoadError(reason instanceof Error ? reason.message : "This title could not be opened."); setBusy(false); } });
    return () => { controller.abort(); saveProgress(true); };
  }, [user, authLoading, router, id, itemId, play, saveProgress]);

  // The title bar fades while you watch and returns when you move, pause or press a key.
  const wake = useCallback(() => { setVisible(true); clearTimeout(idle.current); idle.current = setTimeout(() => { if (video.current && !video.current.paused) setVisible(false); }, HIDE_MS); }, []);
  useEffect(() => () => clearTimeout(idle.current), []);
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const hold = async () => { try { lock = await (navigator as Navigator & { wakeLock?: { request: (kind: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null; } catch { lock = null; } };
    if (stream && !paused) void hold();
    return () => { void lock?.release().catch(() => undefined); };
  }, [stream, paused]);

  const list = files, index = current ? list.findIndex(file => file.token === current) : -1, next = index >= 0 && index + 1 < list.length ? list[index + 1] : null;
  // "Up next": when a file of a pack ends, the next one starts after a short countdown unless cancelled.
  useEffect(() => {
    if (!ended || !next || countdown === null) return;
    if (countdown <= 0) { void play(next.token); return; }
    const timer = setTimeout(() => setCountdown(value => value === null ? null : value - 1), 1000);
    return () => clearTimeout(timer);
  }, [ended, next, countdown, play]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const element = video.current, target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Escape") { if (!document.fullscreenElement) leave(); return; }
      if (!element) return;
      const seek = (seconds: number) => { element.currentTime = Math.max(0, Math.min(element.duration || Infinity, element.currentTime + seconds)); };
      switch (event.key.toLowerCase()) {
        case " ": case "k": if (target?.tagName === "BUTTON" && event.key === " ") return; element.paused ? void element.play() : element.pause(); break;
        case "j": case "arrowleft": seek(-10); break;
        case "l": case "arrowright": seek(10); break;
        case "arrowup": element.volume = Math.min(1, element.volume + 0.1); break;
        case "arrowdown": element.volume = Math.max(0, element.volume - 0.1); break;
        case "m": element.muted = !element.muted; break;
        case "f": if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.().catch(() => undefined); break;
        case "n": if (next) void play(next.token); break;
        default: return;
      }
      event.preventDefault(); wake();
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  }, [leave, next, play, wake]);

  const name = item ? accountMediaName(item) : "", backdrop = safeMediaUrl(item?.metadata?.backdropUrl) ?? safeMediaUrl(item?.metadata?.posterUrl);
  const shown = files.filter(file => file.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const subtitle = [item?.year ?? item?.metadata?.year, item?.metadata?.contentRating, stream?.filename].filter(Boolean).join(" · ");
  if (authLoading || !user) return <div className={styles.page}><p role="status" className={styles.status}>Checking your account…</p></div>;
  return <div ref={root} className={`${styles.page} ${visible || paused || !stream ? "" : styles.idle}`} onMouseMove={wake} onTouchStart={wake} onFocus={wake}>
    <header className={styles.bar}>
      <button type="button" className={styles.back} aria-label="Close player" onClick={leave}><Icon name="chevron" size={22} style={{ transform: "rotate(180deg)" }} /></button>
      <div className={styles.titles}><strong>{name || "Opening…"}</strong>{subtitle && <span>{subtitle}</span>}</div>
      {files.length > 1 && stream && <button type="button" className={styles.bar_button} onClick={() => { video.current?.pause(); saveProgress(true); setChoosing(true); }}>Videos</button>}
      <button type="button" className={styles.bar_button} aria-label="Fullscreen (F)" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.().catch(() => undefined); }}>⛶</button>
    </header>
    {stream && <video ref={video} key={stream.url} className={styles.video} controls autoPlay playsInline preload="metadata" aria-label={`Playing ${name}`}
      onError={() => setVideoError(true)} onPlay={() => { setPaused(false); wake(); }} onPause={() => { setPaused(true); setVisible(true); saveProgress(true); }}
      onLoadedMetadata={event => { const resume = session.current?.resume ?? 0, element = event.currentTarget; if (resume > 5 && resume < element.duration - 5) element.currentTime = resume; }}
      onTimeUpdate={event => { saveProgress(); setPosition({ at: event.currentTarget.currentTime, total: event.currentTarget.duration || 0 }); }}
      onEnded={() => { saveProgress(true); setEnded(true); if (next) setCountdown(NEXT_SECONDS); }}>
      <source src={stream.url} type={sourceType(stream.mimeType)} />Your browser cannot play this video.</video>}
    {!stream && backdrop && <img className={styles.backdrop} src={backdrop} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = "none"; }} />}
    <div className={styles.layer}>
      {busy && !choosing && !playError && pending === null && <div className={styles.center} role="status"><span className={styles.spinner} aria-hidden="true" /><p>Preparing your video…</p></div>}
      {loadError && <div className={styles.card} role="alert"><h2>This title is unavailable.</h2><p>{loadError}</p><button type="button" className="btn btn-secondary" onClick={leave}>Back</button></div>}
      {playError && <div className={styles.card} role="alert"><h2>We couldn’t start this video.</h2><p>{playError}</p><div className={styles.actions}><button type="button" className="btn" disabled={busy} onClick={() => void play(current ?? undefined)}>Try again</button><button type="button" className="btn btn-secondary" onClick={leave}>Back</button></div></div>}
      {pending !== null && <div className={styles.card} role="status"><h2>The server’s provider is still preparing this video.</h2><p>Reported progress: {pending}%. Try again when the transfer is complete. No new torrent was added.</p><div className={styles.actions}><button type="button" className="btn" disabled={busy} onClick={() => void play(current ?? undefined)}>Check again</button><button type="button" className="btn btn-secondary" onClick={leave}>Back</button></div></div>}
      {choosing && files.length > 0 && <div className={`${styles.card} ${styles.wide}`}>
        <h2>This torrent has more than one video.</h2><p>Choose the movie or episode you want to play.</p>
        <label className={styles.search}>Find a video<input type="search" aria-label="Search torrent video files" value={search} maxLength={160} onChange={event => { setSearch(event.target.value); setLimit(50); }} /></label>
        <div className={styles.files}>{shown.slice(0, limit).map(file => <button type="button" key={file.token} disabled={busy} onClick={() => void play(file.token)}><span>{file.name}</span><span>{typeof file.size === "number" && file.size > 0 ? `${(file.size / 1024 ** 3).toFixed(2)} GB` : "Video"}</span></button>)}</div>
        {shown.length > limit && <button type="button" className="btn btn-secondary" onClick={() => setLimit(value => value + 50)}>Show more videos</button>}
        {stream && <button type="button" className="btn btn-secondary" onClick={() => { setChoosing(false); void video.current?.play(); }}>Keep watching</button>}
      </div>}
      {ended && next && countdown !== null && <div className={`${styles.card} ${styles.upnext}`} role="status"><p className={styles.kicker}>UP NEXT</p><h2>{next.name}</h2><p>Starting in {Math.max(0, countdown)} seconds</p><div className={styles.actions}><button type="button" className="btn" onClick={() => void play(next.token)}>Play now</button><button type="button" className="btn btn-secondary" onClick={() => setCountdown(null)}>Cancel</button></div></div>}
      {ended && !(next && countdown !== null) && <div className={`${styles.card} ${styles.upnext}`}><h2>Finished</h2><div className={styles.actions}>{next && <button type="button" className="btn" onClick={() => void play(next.token)}>Play next</button>}<button type="button" className="btn btn-secondary" onClick={leave}>Back to {name}</button></div></div>}
    </div>
    {stream && (videoError || !paused) && <div className={styles.help}><PlaybackHelp url={stream.url} filename={stream.filename} mimeType={stream.mimeType} failed={videoError} /></div>}
    {stream && visible && !choosing && <p className={styles.hint} aria-hidden="true">Space play/pause · J/L ±10s · ↑↓ volume · M mute · F fullscreen{next ? " · N next" : ""} · Esc back{position.total > 0 ? ` · ${clock(position.at)} / ${clock(position.total)}` : ""}</p>}
  </div>;
}
