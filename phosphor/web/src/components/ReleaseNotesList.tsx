"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./SystemMaintenance.module.css";

interface Block { kind: "item" | "text"; text: string }
interface Section { heading: string; blocks: Block[] }
interface Release { version: string; title: string; publishedAt: string | null; url: string | null; sections: Section[] }
interface Notes { current: string; releases: Release[]; error: string | null }
const parts = (value: string) => value.split(".").map(Number);
const newer = (a: string, b: string) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const day = (value: string | null) => { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };

/** The notes of a release as plain text: headings, lists and paragraphs. They arrive already cut into sections and are never shown as markup. */
function Body({ sections }: { sections: Section[] }) {
  return <>{sections.map((section, at) => {
    const groups: Array<{ items: string[] } | { text: string }> = [];
    for (const block of section.blocks) {
      const last = groups[groups.length - 1];
      if (block.kind === "item") { if (last && "items" in last) last.items.push(block.text); else groups.push({ items: [block.text] }); } else groups.push({ text: block.text });
    }
    return <div key={at} className={styles.noteSection}>
      {section.heading && <h5>{section.heading}</h5>}
      {groups.map((group, index) => "items" in group ? <ul key={index}>{group.items.map((text, row) => <li key={row}>{text}</li>)}</ul> : <p key={index}>{group.text}</p>)}
    </div>;
  })}</>;
}

/**
 * "What's new": every feature and correction since the installed version, newest first, from the release notes, inside the app so nobody has to open
 * the release page. With nothing newer, it shows what changed in the version that is installed.
 */
export default function ReleaseNotesList({ updateAvailable, refreshKey }: { updateAvailable: boolean; refreshKey: number }) {
  const [notes, setNotes] = useState<Notes | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api<Notes>(`/api/admin/system/update/notes${refreshKey > 0 ? "?refresh=1" : ""}`).then(found => { if (live) { setNotes(found); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [refreshKey, updateAvailable]);
  if (failed) return <p className={styles.hint}>The release notes could not be loaded just now.</p>;
  if (!notes) return null;
  if (notes.error && !notes.releases.length) return <p className={styles.hint}>{notes.error}</p>;
  const later = notes.releases.filter(release => newer(release.version, notes.current)), mine = notes.releases.find(release => release.version === notes.current);
  if (!later.length && !mine) return null;
  return <section className={styles.notes} aria-label="Release notes">
    {later.length > 0 && <>
      <h4>What’s new in {later.length === 1 ? "the update" : `the ${later.length} updates`}</h4>
      {later.map((release, index) => <details key={release.version} open={index === 0} className={styles.release}>
        <summary><strong>v{release.version}</strong>{release.title ? ` — ${release.title}` : ""}{release.publishedAt ? <span className={styles.noteDate}> · {day(release.publishedAt)}</span> : null}</summary>
        <Body sections={release.sections} />
        {release.url && <p className={styles.hint}><a href={release.url} target="_blank" rel="noreferrer">The release page ↗</a></p>}
      </details>)}
    </>}
    {mine && <details className={styles.release} open={!later.length}>
      <summary><strong>{later.length ? "In the version you have" : "What changed in the version you have"}</strong> — v{mine.version}{mine.title ? `: ${mine.title}` : ""}</summary>
      <Body sections={mine.sections} />
    </details>}
  </section>;
}
