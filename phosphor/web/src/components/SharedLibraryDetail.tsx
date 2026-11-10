"use client";

import PlaybackHelp from "@/components/PlaybackHelp";
import { sourceType } from "@/lib/playback";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMedia, AccountPlayResult, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import { imdbLink, metadataSourceLink, PROVIDER_LABELS } from "@/lib/metadata";
import { SharedLibrary, TitleVersion } from "@/lib/shared-libraries";
import styles from "@/app/library/[id]/detail.module.css";

export default function SharedLibraryDetail() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>(), { user, loading: authLoading } = useAuth(), router = useRouter();
  const [library, setLibrary] = useState<SharedLibrary | null>(null);
  const [versions, setVersions] = useState<TitleVersion[]>([]);
  const [item, setItem] = useState<AccountMedia | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(""), [playing, setPlaying] = useState(false), [playError, setPlayError] = useState("");
  const [stream, setStream] = useState<AccountPlayResult["stream"] | null>(null), [choices, setChoices] = useState<NonNullable<AccountPlayResult["files"]>>([]), [pending, setPending] = useState<number | null>(null), [videoError, setVideoError] = useState(false), [fileSearch, setFileSearch] = useState(""), [fileLimit, setFileLimit] = useState(50);
  const mounted = useRef(false), request = useRef<AbortController | null>(null), playRequest = useRef<AbortController | null>(null), video = useRef<HTMLVideoElement | null>(null);
  const load = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    try {
      const response = await api<{ item: AccountMedia; library: SharedLibrary; versions?: TitleVersion[] }>(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return; setItem(response.item); setLibrary(response.library); setVersions(response.versions ?? []); setError("");
    } catch (reason) { if (!controller.signal.aborted && mounted.current) { setItem(null); setLibrary(null); setStream(null); setChoices([]); setPending(null); setError(reason instanceof Error ? reason.message : "This title could not be loaded."); } }
    finally { if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }, [id, itemId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); playRequest.current?.abort(); }; }, []);
  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
    setItem(null); setLoading(true); setPlaying(false); setStream(null); setChoices([]); setPending(null); setPlayError(""); setLibrary(null);
    if (user) void load();
    return () => { request.current?.abort(); playRequest.current?.abort(); };
  }, [id, itemId, user, authLoading, router, load]);
  const matching = item?.metadataStatus === "queued" || item?.metadataStatus === "processing";
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, attempts = 0;
    const schedule = () => { if (!disposed && matching && attempts < 36 && document.visibilityState === "visible") timer = setTimeout(async () => { attempts++; await load(); schedule(); }, 2500); };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === "visible") { void load(); schedule(); } };
    schedule(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [matching, load]);
  async function play(fileToken?: string) {
    playRequest.current?.abort(); const controller = new AbortController(); playRequest.current = controller;
    setPlaying(true); setPlayError(""); setPending(null); setVideoError(false); video.current?.pause(); setStream(null);
    try {
      const result = await api<AccountPlayResult>(`/api/shared-libraries/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/play`, { method: "POST", signal: controller.signal, body: JSON.stringify(fileToken ? { fileToken } : {}) });
      if (controller.signal.aborted || !mounted.current) return;
      if (result.pending) { setChoices([]); setPending(Math.max(0, Math.min(100, result.progress ?? 0))); return; }
      if (result.selectionRequired && Array.isArray(result.files) && result.files.length) { setChoices(result.files); setFileSearch(""); setFileLimit(50); return; }
      if (result.stream && safeMediaUrl(result.stream.url)) { setStream({ ...result.stream, url: safeMediaUrl(result.stream.url)! }); setChoices([]); return; }
      throw new Error("No playable video was returned. The torrent may need a video file selected by the server owner.");
    } catch (reason) { if (!controller.signal.aborted && mounted.current) setPlayError(reason instanceof Error ? reason.message : "The stream could not be resolved. Try again."); }
    finally { if (!controller.signal.aborted && mounted.current) setPlaying(false); }
  }
  if (authLoading || !user) return <main className={styles.page}><p role="status">Checking your account…</p></main>;
  if (loading && !item) return <main className={styles.page}><p className={styles.loading} role="status">Opening this shared title…</p></main>;
  if (!item) return <main className={styles.page}><Link className={styles.back} href={`/shared-libraries/${encodeURIComponent(id)}`}>← {library?.name ?? "Shared library"}</Link><section className={styles.unavailable}><h1>This title is unavailable.</h1><p>{error || "It may have been removed, or your library access may have changed. Ask the server owner to check."}</p><button type="button" className="btn btn-secondary" onClick={() => void load()}>Try again</button></section></main>;
  const name = accountMediaName(item), metadata = item.metadata, poster = safeMediaUrl(metadata?.posterUrl), backdrop = safeMediaUrl(metadata?.backdropUrl), imdb = imdbLink(metadata?.imdbId), source = metadata ? metadataSourceLink(metadata) : null;
  const filteredFiles = choices.filter(file => file.name.toLocaleLowerCase().includes(fileSearch.trim().toLocaleLowerCase()));
  return <main className={styles.page}>
    <Link className={styles.back} href={`/shared-libraries/${encodeURIComponent(id)}`}>← {library?.name ?? "Shared library"}</Link>
    {error && <p className={styles.error} role="alert">Your last title snapshot is shown. {error}</p>}
    <section className={styles.hero} style={backdrop ? { backgroundImage: `linear-gradient(90deg,var(--bg) 8%,color-mix(in srgb,var(--bg) 78%,transparent)),url("${backdrop.replace(/["\\]/g, "")}")` } : undefined}>
      <div className={styles.poster}><div className={styles.posterFallback} aria-hidden="true"><span>{item.type === "series" ? "SERIES" : "FILM"}</span><strong>{name}</strong><i>{item.year ?? "SERVER COLLECTION"}</i></div>{poster && <img src={poster} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />}</div>
      <div className={styles.heroCopy}><p className={styles.eyebrow}>SHARED BY YOUR SERVER</p><h1>{name}</h1><div className={styles.facts}><span>{item.year ?? metadata?.year ?? "Year unknown"}</span><span>{item.type === "series" ? "Series" : "Movie"}</span>{metadata?.runtimeMinutes != null && <span>{metadata.runtimeMinutes} min</span>}{metadata?.contentRating && <span>{metadata.contentRating}</span>}{metadata?.rating != null && <span>★ {metadata.rating.toFixed(1)} / 10 · {metadata.ratingSource ?? PROVIDER_LABELS[metadata.provider]}</span>}</div>
        {metadata?.genres.length ? <p className={styles.genres}>{metadata.genres.join(" · ")}</p> : null}
        <p className={styles.overview}>{metadata?.description || "This title is part of a collection shared with you by the server. Your server handles the connection when you press Play."}</p>
        <div className={styles.actions}><button type="button" className="btn" aria-label="Play from server" disabled={playing} onClick={() => void play()}>{playing ? "Resolving stream…" : "▶ Play from server"}</button></div>
        {versions.length > 1 && <label className={styles.availability} style={{ display: "block" }}>This title has {versions.length} versions:{" "}<select aria-label="Version" value={item.id} onChange={event => router.push(`/shared-libraries/${encodeURIComponent(id)}/${encodeURIComponent(event.target.value)}`)}>
          {versions.map(version => <option key={version.id} value={version.id}>{version.quality ?? version.release ?? "Version"}{version.phase === "finished" ? "" : ` (${version.phase})`} · added {new Date(version.createdAt).toLocaleDateString()}</option>)}
        </select></label>}
        {user?.role === "admin" && <label className={styles.availability} style={{ display: "block" }}>Age rating (administrators only):{" "}<select aria-label="Age rating" value={item.ratingManual ? item.ratingLabel ?? "" : ""} onChange={event => { void api(`/api/admin/shared-libraries/items/${encodeURIComponent(item.id)}/rating`, { method: "PUT", body: JSON.stringify({ rating: event.target.value || null }) }).then(() => load()).catch(reason => setError(reason instanceof Error ? reason.message : "The rating could not be saved.")); }}>
          <option value="">{!item.ratingManual && item.ratingLabel ? `From metadata: ${item.ratingLabel}` : "Not rated: hidden from limited accounts"}</option>
          {["G", "TV-Y", "TV-Y7", "PG", "TV-PG", "PG-13", "TV-14", "R", "TV-MA"].map(label => <option key={label} value={label}>{label}</option>)}
        </select></label>}
        <p className={styles.availability}>Server-managed playback <span>·</span> {item.phase === "finished" ? "Provider reports ready" : item.phase === "error" ? "Provider entry needs attention" : `${item.phase === "downloading" ? "Downloading" : "Queued"} · ${Math.max(0, Math.min(100, item.progress))}%`}{matching ? " · Metadata matching queued" : item.metadataStatus === "review" ? " · Metadata needs review" : ""}</p>
      </div>
    </section>
    <section className={styles.playback} aria-label="Shared library playback">
      {playError && <div className={styles.playError} role="alert"><h2>We couldn’t start this video.</h2><p>{playError}</p><button type="button" className="btn btn-secondary" disabled={playing} onClick={() => void play()}>Try playback again</button></div>}
      {pending !== null && <div className={styles.pending} role="status"><h2>The server’s provider is still preparing this torrent.</h2><p>Reported progress: {pending}%. Try again when the transfer is complete. No new torrent was added.</p><button type="button" className="btn btn-secondary" disabled={playing} onClick={() => void play()}>Check readiness again</button></div>}
      {choices.length > 0 && <div className={styles.fileChoice}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>CHOOSE YOUR VIDEO</p><h2>This torrent has more than one video.</h2><p>Choose the movie or episode you want to play.</p></div><label>Find a video<input type="search" aria-label="Search torrent video files" value={fileSearch} maxLength={160} onChange={event => { setFileSearch(event.target.value); setFileLimit(50); }} /></label></div><div className={styles.fileList}>{filteredFiles.slice(0, fileLimit).map(file => <button type="button" key={file.token} disabled={playing} onClick={() => void play(file.token)}><span>{file.name}</span><span>{typeof file.size === "number" && file.size > 0 ? `${(file.size / 1024 ** 3).toFixed(2)} GB` : "Video"} ↗</span></button>)}</div>{filteredFiles.length > fileLimit && <button type="button" className="btn btn-secondary" onClick={() => setFileLimit(limit => limit + 50)}>Show more videos</button>}{!filteredFiles.length && <p className={styles.dim}>No video names match this search.</p>}</div>}
      {stream && <div className={styles.player}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>RESOLVED FOR THIS PLAY</p><h2>{stream.filename}</h2></div><button type="button" className={styles.textButton} onClick={() => { video.current?.pause(); setStream(null); }}>Close player</button></div><video ref={video} key={stream.url} controls autoPlay playsInline preload="metadata" onError={() => setVideoError(true)} aria-label={`Playing ${name}`}><source src={stream.url} type={sourceType(stream.mimeType)} />Your browser cannot play this video.</video><PlaybackHelp url={stream.url} filename={stream.filename} mimeType={stream.mimeType} failed={videoError} /><div className={styles.playerFooter}><p>Links are temporary and resolved through the server’s account. This app does not transcode media.</p><a href={stream.url} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">Open temporary stream ↗</a></div></div>}
    </section>
    <section className={styles.details} aria-label="Shared title information"><div><p className={styles.eyebrow}>THE STORY, WITH MORE CONTEXT</p><h2>{metadata?.cast.length ? "Cast" : "Part of your server’s collection"}</h2>{metadata?.cast.length ? <div className={styles.cast}>{metadata.cast.map((person, index) => <span key={`${person}-${index}`}><i aria-hidden="true">{person.split(" ").filter(Boolean).map(part => part[0]).slice(0, 2).join("")}</i>{person}</span>)}</div> : <p className={styles.copy}>The server owner can add artwork, cast and details through automatic metadata matching. You can watch without configuring a personal provider account.</p>}</div><aside className={styles.source}><p className={styles.eyebrow}>WHERE THIS TITLE LIVES</p><h2>Shared collection</h2><dl><div><dt>Playback</dt><dd>Managed by your server</dd></div><div><dt>Library</dt><dd>{library?.name ?? "Shared library"}</dd></div><div><dt>Imported</dt><dd>{Number.isNaN(Date.parse(item.createdAt)) ? "Not recorded" : new Date(item.createdAt).toLocaleDateString()}</dd></div>{metadata && <div><dt>Metadata</dt><dd>{PROVIDER_LABELS[metadata.provider]}</dd></div>}{metadata?.imdbId && <div><dt>IMDb ID</dt><dd>{metadata.imdbId}</dd></div>}</dl><div className={styles.sourceLinks}>{imdb && <a href={imdb} target="_blank" rel="noreferrer">View IMDb ↗</a>}{source && source !== imdb && <a href={source} target="_blank" rel="noreferrer">Metadata source ↗</a>}</div></aside></section>
    {metadata && <footer className={styles.attribution}>{metadata.provider === "tmdb" && <img src="/metadata/tmdb.svg" alt="TMDB" width={94} height={24} />}<p>{metadata.provider === "tmdb" ? "This product uses the TMDB API but is not endorsed or certified by TMDB." : metadata.provider === "free" ? "Metadata from Cinemeta, which serves IMDb-linked data. No account is used." : "IMDb-linked metadata supplied by OMDb."} Metadata and artwork belong to their respective providers and rights holders.</p></footer>}
  </main>;
}
