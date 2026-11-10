"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { safeMediaUrl } from "@/lib/account-library";
import { Slide } from "@/lib/home";
import { Icon } from "@/components/Icon";
import styles from "./HomeCarousel.module.css";

const SLIDE_MS = 8000, TRAILER_SLIDE_MS = 28000, TRAILER_DELAY_MS = 1800, STORAGE_KEY = "streamrd.trailers";
const embed = (id: string, background: boolean) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0&modestbranding=1&${background ? `mute=1&controls=0&disablekb=1&loop=1&playlist=${id}` : "controls=1"}`;
const read = () => { try { return window.localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; } };

/**
 * The home banner: a rotating carousel of featured titles, Apple TV style. Trailers are optional and per viewer: nothing is loaded from
 * YouTube until the viewer turns on "Autoplay trailers" or presses "Watch trailer", and reduced-motion settings stop all movement.
 */
export default function HomeCarousel({ slides, trailersEnabled }: { slides: Slide[]; trailersEnabled: boolean }) {
  const [index, setIndex] = useState(0), [paused, setPaused] = useState(false), [reduced, setReduced] = useState(false), [autoplay, setAutoplay] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null), [watching, setWatching] = useState<number | null>(null), [stopped, setStopped] = useState(false);
  const root = useRef<HTMLElement | null>(null), count = slides.length;
  useEffect(() => { setAutoplay(read()); const media = window.matchMedia("(prefers-reduced-motion: reduce)"); const sync = () => setReduced(media.matches); sync(); media.addEventListener("change", sync); return () => media.removeEventListener("change", sync); }, []);
  const go = useCallback((next: number) => { setIndex((next + count) % count); setWatching(null); }, [count]);
  const slide = slides[index], backgroundTrailer = trailersEnabled && autoplay && !reduced && slide?.trailer && playing === index && watching === null;
  // A trailer starts shortly after a slide appears, so quickly skipping through slides loads nothing.
  useEffect(() => {
    setPlaying(null);
    if (!trailersEnabled || !autoplay || reduced || !slide?.trailer) return;
    const timer = setTimeout(() => { if (!document.hidden) setPlaying(index); }, TRAILER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [index, trailersEnabled, autoplay, reduced, slide?.trailer]);
  useEffect(() => {
    if (count < 2 || paused || reduced || stopped || watching !== null) return;
    const timer = setTimeout(() => go(index + 1), backgroundTrailer ? TRAILER_SLIDE_MS : SLIDE_MS);
    return () => clearTimeout(timer);
  }, [index, count, paused, reduced, stopped, watching, backgroundTrailer, go]);
  useEffect(() => { const hide = () => setPaused(document.hidden); document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide); }, []);
  if (!count) return null;
  const toggleAutoplay = (on: boolean) => { setAutoplay(on); try { window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); } catch { /* the choice just lasts for this visit */ } };
  return <section ref={root} className={styles.carousel} aria-roledescription="carousel" aria-label="Featured titles"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) setPaused(false); }}
    onKeyDown={event => { if (event.key === "ArrowRight") go(index + 1); else if (event.key === "ArrowLeft") go(index - 1); }}>
    {slides.map((entry, position) => {
      const backdrop = safeMediaUrl(entry.backdropUrl), current = position === index;
      return <div key={`${entry.kind}/${entry.id}`} className={`${styles.slide} ${current ? styles.current : ""}`} role="group" aria-roledescription="slide" aria-label={`${position + 1} of ${count}: ${entry.title}`} aria-hidden={!current}>
        {backdrop && <img className={styles.backdrop} src={backdrop} alt="" referrerPolicy="no-referrer" loading={position === 0 ? "eager" : "lazy"} onError={event => { event.currentTarget.style.display = "none"; }} />}
        {current && entry.trailer && (watching === position
          ? <iframe className={styles.watch} src={embed(entry.trailer, false)} title={`Trailer: ${entry.title}`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
          : backgroundTrailer && <iframe className={styles.trailer} src={embed(entry.trailer, true)} title="" aria-hidden="true" tabIndex={-1} allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" />)}
        <div className={styles.shade} />
        {watching !== position && <div className={styles.copy}>
          <span className={styles.kicker}>{entry.label}</span>
          <h2>{entry.title}</h2>
          <div className={styles.meta}>{entry.year && <span>{entry.year}</span>}{entry.rating ? <span>★ {entry.rating.toFixed(1)}</span> : null}{entry.genres.length > 0 && <span>{entry.genres.join(" · ")}</span>}</div>
          <p>{entry.description}</p>
          <div className={styles.actions}>
            <Link href={entry.href} className="btn" tabIndex={current ? 0 : -1}><Icon name="play" size={18} />{entry.kind === "library" ? "Open" : "View details"}</Link>
            {trailersEnabled && entry.trailer && <button type="button" className="btn btn-secondary" tabIndex={current ? 0 : -1} onClick={() => { setWatching(position); setPlaying(null); }}>Watch trailer</button>}
          </div>
        </div>}
        {watching === position && <button type="button" className={`btn btn-secondary ${styles.close}`} onClick={() => setWatching(null)}>Close trailer</button>}
      </div>;
    })}
    <div className={styles.controls}>
      <div className={styles.dots} role="group" aria-label="Choose a featured title">{slides.map((entry, position) => <button key={`${entry.kind}/${entry.id}`} type="button" className={position === index ? styles.dotOn : styles.dot} aria-label={`Show ${entry.title}`} aria-current={position === index} onClick={() => go(position)} />)}</div>
      {count > 1 && <div className={styles.arrows}>
        <button type="button" className={styles.arrow} aria-label="Previous featured title" onClick={() => go(index - 1)}><Icon name="chevron" size={18} style={{ transform: "rotate(180deg)" }} /></button>
        <button type="button" className={styles.arrow} aria-label={stopped ? "Resume automatic rotation" : "Pause automatic rotation"} aria-pressed={stopped} onClick={() => setStopped(value => !value)}>{stopped ? <Icon name="play" size={16} /> : <span aria-hidden="true">❚❚</span>}</button>
        <button type="button" className={styles.arrow} aria-label="Next featured title" onClick={() => go(index + 1)}><Icon name="chevron" size={18} /></button>
      </div>}
    </div>
    {trailersEnabled && watching === null && slides.some(entry => entry.trailer) && <label className={styles.autoplay}><input type="checkbox" checked={autoplay} onChange={event => toggleAutoplay(event.target.checked)} /><span>Autoplay trailers <small>(your browser loads them from YouTube)</small></span></label>}
  </section>;
}
