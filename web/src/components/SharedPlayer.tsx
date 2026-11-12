"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { mseSupported, startMse } from "@/lib/mse-playback";
import { api, API_BASE } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMedia, AccountPlayResult, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import { sourceType } from "@/lib/playback";
import PlaybackHelp from "@/components/PlaybackHelp";
import { Icon } from "@/components/Icon";
import styles from "./SharedPlayer.module.css";

type Files = NonNullable<AccountPlayResult["files"]>;
const HIDE_MS = 3200, NEXT_SECONDS = 10;
type Playback = NonNullable<AccountPlayResult["playback"]>;
const CONVERSION: Record<string, string> = { remux: "Repackaged for your browser", audio: "Audio converted for your browser", video: "Converted for your browser" };
/** A provider lists the files of a torrent as paths ("/Show.S01E01.mkv", "Folder/Film.mkv"); viewers see the name. */
const fileLabel = (name: string) => name.replace(/^[\\/]+/, "").split(/[\\/]/).filter(Boolean).slice(-2).join(" / ") || name;
const clock = (seconds: number) => { const total = Math.max(0, Math.floor(seconds)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60; return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`; };

/**
 * The full-page player, in the style of Plex: a black page with the video, a title bar that fades away while you watch, keyboard shortcuts,
 * resume, a file/episode chooser, "Up next" for the next file of a pack, and a hand-off to VLC or mpv when a browser cannot play a file.
 * Playback is resolved by the server's own account. A file a browser cannot open (MKV, DTS, HEVC...) is converted by the server while you watch, and the
 * player then draws its own seek bar, because a converted stream has no length of its own: seeking restarts the stream at the chosen second.
 */
export default function SharedPlayer() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>(), { user, loading: authLoading } = useAuth(), router = useRouter();
  const [item, setItem] = useState<AccountMedia | null>(null), [loadError, setLoadError] = useState(""), [busy, setBusy] = useState(true), [playError, setPlayError] = useState(""), [pending, setPending] = useState<number | null>(null);
  const [files, setFiles] = useState<Files>([]), [current, setCurrent] = useState<string | null>(null), [choosing, setChoosing] = useState(false), [search, setSearch] = useState(""), [limit, setLimit] = useState(50);
  const [stream, setStream] = useState<NonNullable<AccountPlayResult["stream"]> | null>(null), [videoError, setVideoError] = useState(false), [ended, setEnded] = useState(false), [countdown, setCountdown] = useState<number | null>(null);
  const [visible, setVisible] = useState(true), [paused, setPaused] = useState(true), [position, setPosition] = useState({ at: 0, total: 0 });
  const [playback, setPlayback] = useState<Playback | null>(null), [startAt, setStartAt] = useState(0), [scrub, setScrub] = useState<number | null>(null);
  const converted = playback && playback.mode !== "direct" && playback.url ? playback : null;
  const [reason, setReason] = useState("");
  // A copied picture can be undecodable from where a resumed or sought stream starts (open-GOP H.264): the browser reports a decode error.
  // The player then asks the server once to re-encode the picture from that moment, and keeps doing so for the rest of this video.
  const [forceVideo, setForceVideo] = useState(false);
  // Where a converted stream really starts. A copied picture can only start on a keyframe, at or before the asked second; the server cuts the
  // sound from the same place, so both begin together, and tells the player where that is. The position shown is this plus the stream's own
  // clock, and the player then moves ahead inside the stream to the second that was asked for, once enough of it has arrived.
  const [landing, setLanding] = useState<{ at: number; start: number } | null>(null), [skipping, setSkipping] = useState(false), [buffering, setBuffering] = useState(true);
  // Through the browser's streaming API (Chrome, Firefox, Safari on a computer or iPad) the video has a real clock, so positions are the video's own;
  // otherwise the stream is a plain <video src> that is opened again at each skip and is asked where it starts.
  const [mseCapable, setMseCapable] = useState(false), [mseBroken, setMseBroken] = useState(false);
  useEffect(() => { setMseCapable(mseSupported()); }, []);
  const useMse = Boolean(converted) && mseCapable && !mseBroken && (converted?.durationSeconds ?? 0) > 0;
  const base = converted && !useMse ? (landing && landing.at === startAt ? landing.start : startAt) : 0;
  const baseRef = useRef(0); baseRef.current = base;
  const holding = useRef(false);   // the player has paused the video itself, to move it ahead: not a pause by the viewer
  useEffect(() => {
    setLanding(null); if (!converted?.url || useMse) return;
    const controller = new AbortController();
    fetch(`${API_BASE}${converted.url}/start?at=${startAt}${forceVideo ? "&video=1" : ""}`, { credentials: "include", signal: controller.signal }).then(response => response.ok ? response.json() : Promise.reject(new Error("no answer")))
      .then((answer: { start?: number }) => setLanding({ at: startAt, start: typeof answer.start === "number" && answer.start >= 0 && answer.start <= startAt ? answer.start : startAt }))
      .catch(() => { if (!controller.signal.aborted) setLanding({ at: startAt, start: startAt }); });
    return () => controller.abort();
  }, [converted?.url, startAt, forceVideo, useMse]);
  useEffect(() => {
    const element = video.current; setSkipping(false);
    if (!converted || useMse || !element || !landing || landing.at !== startAt) return;
    const offset = landing.at - landing.start; if (offset <= 0.3) return;
    let finished = false; setSkipping(true); holding.current = true; element.pause();
    const done = () => { finished = true; holding.current = false; setSkipping(false); void element.play().catch(() => undefined); };
    const land = () => {
      if (finished) return; const ranges = element.buffered, end = ranges.length ? ranges.end(ranges.length - 1) : 0;
      if (end < offset + 0.5 && !element.ended) return;
      element.currentTime = Math.max(0, Math.min(offset, end - 0.1)); done();
    };
    const timer = setInterval(land, 200), giveUp = setTimeout(() => { if (!finished) done(); }, 20_000);   // never hold the video for good
    return () => { clearInterval(timer); clearTimeout(giveUp); if (!finished) { holding.current = false; setSkipping(false); } };
  }, [converted, landing, startAt, useMse]);
  const startRef = useRef(0); startRef.current = startAt;
  useEffect(() => {
    const element = video.current; if (!useMse || !element || !converted?.url) return;
    const url = converted.url; setVideoError(false);
    const handle = startMse({ video: element, duration: converted.durationSeconds, initial: startRef.current, forceVideo,
      streamUrl: (start, force) => `${API_BASE}${url}?start=${start.toFixed(3)}${force ? "&video=1" : ""}`, startUrl: (at, force) => `${API_BASE}${url}/start?at=${at.toFixed(3)}${force ? "&video=1" : ""}`,
      onProblem: (kind, message) => { if (kind === "unsupported") setMseBroken(true); else { setReason(message); setVideoError(true); } } });
    return () => handle.destroy();
  }, [useMse, converted?.url, converted?.durationSeconds, forceVideo]);
  // When a converted video fails to play, ask the server why (its own message; never the link).
  useEffect(() => {
    if (!videoError || !converted?.url) { setReason(""); return; }
    let live = true;
    fetch(`${API_BASE}${converted.url}/status`, { credentials: "include" }).then(response => response.json()).then((status: { lastError?: string | null; known?: boolean }) => { if (live) setReason(status.known === false ? "The converted stream expired. Press Try again or reopen the video." : status.lastError ?? ""); }).catch(() => undefined);
    return () => { live = false; };
  }, [videoError, converted?.url]);
  const mounted = useRef(false), request = useRef<AbortController | null>(null), root = useRef<HTMLDivElement | null>(null), video = useRef<HTMLVideoElement | null>(null), idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const session = useRef<{ id: string; sequence: number; sentAt: number; resume: number; position: number; duration: number } | null>(null);
  const detail = `/shared-libraries/${encodeURIComponent(id)}/${encodeURIComponent(itemId)}`;

  const saveProgress = useCallback((force = false) => {
    const element = video.current, now = session.current; if (!now) return;
    if (converted && converted.durationSeconds > 0) { now.position = Math.min(baseRef.current + (element?.currentTime ?? 0), converted.durationSeconds); now.duration = converted.durationSeconds; }
    else if (element && Number.isFinite(element.duration) && element.duration > 0) { now.position = Math.min(element.currentTime, element.duration); now.duration = element.duration; }
    if (now.duration <= 0 || now.position <= 0) return;
    const at = Date.now(); if (!force && at - now.sentAt < 15000) return;
    now.sentAt = at; now.sequence += 1;
    void api(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/progress`, { method: "PUT", keepalive: true, body: JSON.stringify({ sessionId: now.id, sequence: now.sequence, positionSeconds: now.position, durationSeconds: now.duration }) }).catch(() => undefined);
  }, [id, itemId, converted, startAt]);
  // The effects that open the title and start playback must run once per title. saveProgress changes whenever playback state does
  // (a converted stream replaces it), so they reach it through this ref. Depending on it directly made the player open the title again
  // each time a converted stream arrived: play, new stream, play again, without end, until the server refused the requests.
  const saveLatest = useRef(saveProgress);
  useEffect(() => { saveLatest.current = saveProgress; }, [saveProgress]);
  const leave = useCallback(() => { video.current?.pause(); saveProgress(true); session.current = null; if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); router.push(detail); }, [saveProgress, router, detail]);

  const play = useCallback(async (fileToken?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setPlayError(""); setPending(null); setVideoError(false); setEnded(false); setCountdown(null); video.current?.pause(); setStream(null); setPlayback(null); setStartAt(0); setScrub(null); setForceVideo(false);
    try {
      const result = await api<AccountPlayResult>(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/play`, { method: "POST", signal: controller.signal, body: JSON.stringify(fileToken ? { fileToken } : {}) });
      if (controller.signal.aborted || !mounted.current) return;
      if (result.pending) { setPending(Math.max(0, Math.min(100, result.progress ?? 0))); return; }
      if (result.selectionRequired && Array.isArray(result.files) && result.files.length) { setFiles(result.files); setChoosing(true); setSearch(""); setLimit(50); return; }
      const url = result.stream ? safeMediaUrl(result.stream.url) : null;
      if (result.stream && url) {
        session.current = result.progressSessionId ? { id: result.progressSessionId, sequence: 0, sentAt: Date.now(), resume: result.resumeSeconds ?? 0, position: 0, duration: 0 } : null;
        setStream({ ...result.stream, url }); setPlayback(result.playback ?? null); setStartAt(result.playback?.url && result.playback.mode !== "direct" && (result.resumeSeconds ?? 0) > 5 ? Math.floor(result.resumeSeconds ?? 0) : 0); setChoosing(false); setCurrent(fileToken ?? null); return;
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
    return () => { controller.abort(); saveLatest.current(true); };
  }, [user, authLoading, router, id, itemId, play]);

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

  const jump = useCallback((seconds: number) => {
    saveProgress(true); setScrub(null); setEnded(false); setVideoError(false);
    const element = video.current;
    if (useMse && element) element.currentTime = Math.max(0, Math.floor(seconds));   // the streaming player opens the stream there itself when it has to
    else setStartAt(Math.max(0, Math.floor(seconds)));
  }, [saveProgress, useMse]);
  // A seek in a converted stream restarts the conversion, so the position being chosen is kept here (not only in state, which a quick click
  // or tap can outrun) and sent once: at the end of a drag, or a moment after the last key press instead of once per press.
  const seeking = useRef<{ target: number | null; timer?: ReturnType<typeof setTimeout> }>({ target: null });
  const commitSeek = useCallback((delay = 0) => {
    clearTimeout(seeking.current.timer);
    const go = () => { const target = seeking.current.target; seeking.current.target = null; if (target !== null) jump(target); };
    if (delay > 0) seeking.current.timer = setTimeout(go, delay); else go();
  }, [jump]);
  const aimSeek = useCallback((seconds: number) => { seeking.current.target = seconds; setScrub(seconds); }, []);
  useEffect(() => { const state = seeking.current; return () => clearTimeout(state.timer); }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const element = video.current, target = event.target as HTMLElement | null;
      // Typing in a field keeps its keys. The seek bar is not typing: it keeps only its own arrow keys, so Space, Esc, F, M and the rest
      // still work after a click on it has left the focus there.
      const onSeekBar = target?.tagName === "INPUT" && (target as HTMLInputElement).type === "range";
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) && !onSeekBar) return;
      if (onSeekBar && /^(?:Arrow|Home$|End$|Page)/.test(event.key)) return;
      if (event.key === "Escape") { if (!document.fullscreenElement) leave(); return; }
      if (!element) return;
      const seek = (seconds: number) => { if (converted && converted.durationSeconds > 0) { aimSeek(Math.max(0, Math.min(converted.durationSeconds - 1, (seeking.current.target ?? baseRef.current + element.currentTime) + seconds))); commitSeek(450); } else element.currentTime = Math.max(0, Math.min(element.duration || Infinity, element.currentTime + seconds)); };
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
  }, [leave, next, play, wake, converted, startAt, aimSeek, commitSeek]);

  const name = item ? accountMediaName(item) : "", backdrop = safeMediaUrl(item?.metadata?.backdropUrl) ?? safeMediaUrl(item?.metadata?.posterUrl);
  const shown = files.filter(file => file.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const subtitle = [item?.year ?? item?.metadata?.year, item?.metadata?.contentRating, stream?.filename, converted ? CONVERSION[forceVideo ? "video" : converted.mode] : null].filter(Boolean).join(" · ");
  const source = stream ? converted ? `${API_BASE}${converted.url}?start=${startAt}${forceVideo ? "&video=1" : ""}` : stream.url : "", shownTotal = converted ? converted.durationSeconds : position.total, shownAt = Math.min(scrub ?? (converted ? base + position.at : position.at), shownTotal > 0 ? shownTotal : Infinity);
  const playKey = useMse && converted ? `mse:${converted.url}:${forceVideo}` : source;
  useEffect(() => { setBuffering(true); }, [playKey]);   // a stream just opened is buffering until it plays
  if (authLoading || !user) return <div className={styles.page}><p role="status" className={styles.status}>Checking your account…</p></div>;
  return <div ref={root} className={`${styles.page} ${visible || paused || !stream ? "" : styles.idle}`} onMouseMove={wake} onTouchStart={wake} onFocus={wake}>
    <header className={styles.bar}>
      <button type="button" className={styles.back} aria-label="Close player" onClick={leave}><Icon name="chevron" size={22} style={{ transform: "rotate(180deg)" }} /></button>
      <div className={styles.titles}><strong>{name || "Opening…"}</strong>{subtitle && <span>{subtitle}</span>}</div>
      {files.length > 1 && stream && <button type="button" className={styles.bar_button} onClick={() => { video.current?.pause(); saveProgress(true); setChoosing(true); }}>Videos</button>}
      <button type="button" className={styles.bar_button} aria-label="Fullscreen (F)" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.().catch(() => undefined); }}>⛶</button>
    </header>
    {stream && <video ref={video} key={playKey} className={styles.video} controls={!converted} autoPlay playsInline preload={converted ? "auto" : "metadata"} aria-label={`Playing ${name}`}
      onError={event => {
        const element = event.currentTarget, code = element.error?.code;
        /* While the player is still on its way to the asked second, the picture is converted from that second, not from where the copied stream began. */
        if (converted && converted.mode !== "video" && !forceVideo && (code === 3 || code === 4)) { saveProgress(true); setStartAt(Math.max(0, Math.floor(holding.current ? startAt : baseRef.current + element.currentTime))); setForceVideo(true); return; }
        setVideoError(true);
      }} onPlay={() => { setPaused(false); wake(); }} onPause={() => { if (holding.current) return; setPaused(true); setVisible(true); saveProgress(true); }}
      onWaiting={() => setBuffering(true)} onPlaying={() => setBuffering(false)} onSeeked={() => setBuffering(false)}
      onLoadedMetadata={event => { if (converted) return; const resume = session.current?.resume ?? 0, element = event.currentTarget; if (resume > 5 && resume < element.duration - 5) element.currentTime = resume; }}
      onTimeUpdate={event => { saveProgress(); setPosition({ at: event.currentTarget.currentTime, total: converted ? 0 : event.currentTarget.duration || 0 }); }}
      onEnded={() => { saveProgress(true); setEnded(true); if (next) setCountdown(NEXT_SECONDS); }}>
      {!useMse && <source src={source} type={converted ? "video/mp4" : sourceType(stream.mimeType)} onError={() => setVideoError(true)} />}Your browser cannot play this video.</video>}
    {stream && converted && !choosing && <div className={`${styles.controls} ${visible || paused ? "" : styles.controlsIdle}`} role="group" aria-label="Playback controls">
      <button type="button" className={styles.bar_button} aria-label={paused ? "Play" : "Pause"} onClick={() => { const element = video.current; if (element) element.paused ? void element.play() : element.pause(); }}>{paused ? "▶" : "❚❚"}</button>
      <span className={styles.clock}>{clock(shownAt)}</span>
      <input type="range" className={styles.scrubber} aria-label="Seek" min={0} max={Math.max(1, Math.floor(shownTotal))} step={1} value={Math.min(Math.floor(shownAt), Math.max(1, Math.floor(shownTotal)))} disabled={shownTotal <= 0}
        onChange={event => aimSeek(Number(event.target.value))} onPointerUp={() => commitSeek()} onPointerCancel={() => { seeking.current.target = null; setScrub(null); }}
        onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commitSeek(450); }} onBlur={() => commitSeek()} />
      <span className={styles.clock}>{shownTotal > 0 ? clock(shownTotal) : "—"}</span>
      <button type="button" className={styles.bar_button} aria-label="Mute (M)" onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}>🔊</button>
    </div>}
    {!stream && backdrop && <img className={styles.backdrop} src={backdrop} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = "none"; }} />}
    <div className={styles.layer}>
      {busy && !choosing && !playError && pending === null && <div className={styles.center} role="status"><span className={styles.spinner} aria-hidden="true" /><p>Preparing your video…</p></div>}
      {stream && converted && (buffering || skipping) && !busy && !videoError && !choosing && !ended && !playError && pending === null && <div className={styles.center} role="status"><span className={styles.spinner} aria-hidden="true" /><p>{skipping ? `Skipping to ${clock(startAt)}…` : "Buffering…"}</p></div>}
      {loadError && <div className={styles.card} role="alert"><h2>This title is unavailable.</h2><p>{loadError}</p><button type="button" className="btn btn-secondary" onClick={leave}>Back</button></div>}
      {playError && <div className={styles.card} role="alert"><h2>We couldn’t start this video.</h2><p>{playError}</p><div className={styles.actions}><button type="button" className="btn" disabled={busy} onClick={() => void play(current ?? undefined)}>Try again</button><button type="button" className="btn btn-secondary" onClick={leave}>Back</button></div></div>}
      {pending !== null && <div className={styles.card} role="status"><h2>The server’s provider is still preparing this video.</h2><p>Reported progress: {pending}%. Try again when the transfer is complete. No new torrent was added.</p><div className={styles.actions}><button type="button" className="btn" disabled={busy} onClick={() => void play(current ?? undefined)}>Check again</button><button type="button" className="btn btn-secondary" onClick={leave}>Back</button></div></div>}
      {choosing && files.length > 0 && <div className={`${styles.card} ${styles.wide}`}>
        <h2>This torrent has more than one video.</h2><p>Choose the movie or episode you want to play.</p>
        <label className={styles.search}>Find a video<input type="search" aria-label="Search torrent video files" value={search} maxLength={160} onChange={event => { setSearch(event.target.value); setLimit(50); }} /></label>
        <div className={styles.files}>{shown.slice(0, limit).map(file => <button type="button" key={file.token} disabled={busy} onClick={() => void play(file.token)}><span>{fileLabel(file.name)}</span><span>{typeof file.size === "number" && file.size > 0 ? `${(file.size / 1024 ** 3).toFixed(2)} GB` : "Video"}</span></button>)}</div>
        {shown.length > limit && <button type="button" className="btn btn-secondary" onClick={() => setLimit(value => value + 50)}>Show more videos</button>}
        {stream && <button type="button" className="btn btn-secondary" onClick={() => { setChoosing(false); void video.current?.play(); }}>Keep watching</button>}
      </div>}
      {ended && next && countdown !== null && <div className={`${styles.card} ${styles.upnext}`} role="status"><p className={styles.kicker}>UP NEXT</p><h2>{fileLabel(next.name)}</h2><p>Starting in {Math.max(0, countdown)} seconds</p><div className={styles.actions}><button type="button" className="btn" onClick={() => void play(next.token)}>Play now</button><button type="button" className="btn btn-secondary" onClick={() => setCountdown(null)}>Cancel</button></div></div>}
      {ended && !(next && countdown !== null) && <div className={`${styles.card} ${styles.upnext}`}><h2>Finished</h2><div className={styles.actions}>{next && <button type="button" className="btn" onClick={() => void play(next.token)}>Play next</button>}<button type="button" className="btn btn-secondary" onClick={leave}>Back to {name}</button></div></div>}
    </div>
    {stream && (videoError || (!paused && !converted)) && <div className={styles.help}><PlaybackHelp url={stream.url} filename={stream.filename} mimeType={stream.mimeType} failed={videoError} converted={Boolean(converted)} reason={reason} /></div>}
    {stream && visible && !choosing && <p className={styles.hint} aria-hidden="true">Space play/pause · J/L ±10s · ↑↓ volume · M mute · F fullscreen{next ? " · N next" : ""} · Esc back{shownTotal > 0 ? ` · ${clock(shownAt)} / ${clock(shownTotal)}` : ""}</p>}
  </div>;
}
