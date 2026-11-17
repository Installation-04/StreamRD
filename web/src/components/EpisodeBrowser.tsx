"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { episodeOf, groupEpisodes } from "@/lib/episodes";
import styles from "./EpisodeBrowser.module.css";

interface EpisodeFile { token: string; name: string; size?: number; watched?: boolean; percent?: number }
/** What follows the episode number in a file name, up to the quality tags: "Show.S01E02.The.Gate.1080p.mkv" → "The Gate". Empty when there is none. */
export function episodeTitle(name: string): string {
  const base = name.replace(/^[\\/]+/, "").split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? name;
  const after = /(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})(?:[ ._-]?(?:e|-e)?\d{1,3})*[ ._-]+(.*)$/i.exec(base)?.[1] ?? "";
  const cut = after.replace(/\.[a-z0-9]{2,4}$/i, "").split(/[ ._-](?=(?:\d{3,4}p|4k|uhd|web|webrip|web-dl|bluray|bdrip|brrip|hdtv|dvdrip|x26[45]|h26[45]|hevc|remux|amzn|nf|proper|repack)\b)/i)[0];
  return cut.replace(/[._]+/g, " ").trim();
}

/** The seasons and episodes of a title on its own page, the way a media server shows them: a tab per season, a row per episode with what the viewer has watched, and one button for what to watch next. */
export default function EpisodeBrowser({ libraryId, itemId }: { libraryId: string; itemId: string }) {
  const router = useRouter();
  const [files, setFiles] = useState<EpisodeFile[] | null>(null), [note, setNote] = useState(""), [tab, setTab] = useState<number | null>(null), [marking, setMarking] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setFiles(null); setNote("");
    api<{ files: EpisodeFile[]; pending?: boolean; progress?: number }>(`/api/shared-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}/episodes`, { signal: controller.signal })
      .then(result => { if (controller.signal.aborted) return; setFiles(result.files); if (result.pending) setNote(`The provider is still preparing these episodes (${result.progress ?? 0}%).`); })
      .catch(reason => { if (!controller.signal.aborted) { setFiles([]); setNote(reason instanceof Error ? reason.message : "The episodes could not be listed."); } });
    return () => controller.abort();
  }, [libraryId, itemId]);
  async function mark(tokens: string[], watched: boolean) {
    if (marking || !tokens.length) return; setMarking(true); setNote("");
    try { const result = await api<{ files: EpisodeFile[] }>(`/api/shared-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}/episodes/watched`, { method: "POST", body: JSON.stringify({ tokens, watched }) }); setFiles(result.files); }
    catch (reason) { setNote(reason instanceof Error ? reason.message : "That could not be saved. Try again."); }
    finally { setMarking(false); }
  }
  if (files === null) return <section className={styles.box} aria-label="Episodes" aria-busy="true"><p className={styles.note} role="status">Loading episodes…</p></section>;
  const grouped = groupEpisodes(files);
  if (!grouped) return note ? <section className={styles.box} aria-label="Episodes"><p className={styles.note} role="status">{note}</p></section> : null;
  const ordered = grouped.seasons.flatMap(group => group.items.map(({ file, episode }) => ({ file, episode, season: group.season })));
  // What to watch next: the episode begun last in order, or else the first one not yet watched, or else the very first.
  const begun = ordered.find(entry => entry.file.percent && !entry.file.watched), unseen = ordered.find(entry => !entry.file.watched), target = begun ?? unseen ?? ordered[0];
  const label = (entry: { season: number; episode: number }) => `S${entry.season}·E${entry.episode}`;
  const active = tab !== null && grouped.seasons.some(group => group.season === tab) ? tab : target.season, season = grouped.seasons.find(group => group.season === active)!;
  const href = (token: string) => `/play/${encodeURIComponent(libraryId)}/${encodeURIComponent(itemId)}?file=${token}`;
  const watchedIn = (items: Array<{ file: EpisodeFile }>) => items.filter(entry => entry.file.watched).length;
  return <section className={styles.box} aria-label="Episodes">
    <div className={styles.top}>
      <h2>Episodes</h2>
      <div className={styles.actions}>
        <Link className="btn" href={href(target.file.token)}>▶ {begun ? "Resume" : unseen && unseen !== ordered[0] ? "Play next" : unseen ? "Play" : "Play again"} {label(target)}</Link>
        {ordered.length > 1 && <button type="button" className="btn btn-secondary" title="Play an episode picked at random, one you have not watched if there is one" onClick={() => { const pool = ordered.filter(entry => !entry.file.watched), from = pool.length ? pool : ordered, pick = from[Math.floor(Math.random() * from.length)]; router.push(href(pick.file.token)); }}>Shuffle</button>}
      </div>
    </div>
    {note && <p className={styles.note} role="status">{note}</p>}
    <div role="tablist" aria-label="Seasons" className={styles.tabs}>
      {grouped.seasons.map(group => <button type="button" role="tab" key={group.season} aria-selected={active === group.season} className={active === group.season ? styles.on : undefined} onClick={() => setTab(group.season)}>Season {group.season}<small>{watchedIn(group.items)}/{group.items.length}</small></button>)}
    </div>
    <div className={styles.seasonActions}>
      {watchedIn(season.items) < season.items.length && <button type="button" className={styles.linkish} disabled={marking} onClick={() => void mark(season.items.map(entry => entry.file.token), true)}>Mark season {season.season} watched</button>}
      {watchedIn(season.items) > 0 && <button type="button" className={styles.linkish} disabled={marking} onClick={() => void mark(season.items.map(entry => entry.file.token), false)}>Mark season {season.season} unwatched</button>}
    </div>
    <ol className={styles.list}>
      {season.items.map(({ file, episode }) => <li key={file.token} className={file.watched ? styles.seen : undefined}>
        <Link href={href(file.token)} aria-label={`Play season ${season.season} episode ${episode}`}>
          <span className={styles.num}>{episode}</span>
          <span className={styles.title}><strong>{episodeTitle(file.name) || `Episode ${episode}`}</strong>{typeof file.size === "number" && file.size > 0 && <small>{(file.size / 1e9).toFixed(file.size > 1e10 ? 0 : 1)} GB</small>}</span>
          {!file.watched && file.percent ? <span className={styles.bar} role="img" aria-label={`${file.percent}% watched`}><i style={{ width: `${file.percent}%` }} /></span> : <span className={styles.play} aria-hidden="true">▶</span>}
        </Link>
        <button type="button" className={file.watched ? styles.check : styles.uncheck} disabled={marking} aria-pressed={Boolean(file.watched)} aria-label={`${file.watched ? "Mark unwatched" : "Mark watched"}: season ${season.season} episode ${episode}`} title={file.watched ? "Watched: click to mark unwatched" : "Mark watched"} onClick={() => void mark([file.token], !file.watched)}>✓</button>
      </li>)}
    </ol>
  </section>;
}
