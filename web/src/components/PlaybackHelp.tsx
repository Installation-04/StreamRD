"use client";

import { useState } from "react";
import { playbackAdvice } from "@/lib/playback";
import styles from "./PlaybackHelp.module.css";

/** Plain-language help when a browser cannot play a resolved file, plus a hand-off to a real player. */
export default function PlaybackHelp({ url, filename, mimeType, failed, converted }: { url: string; filename?: string; mimeType?: string; failed: boolean; converted?: boolean }) {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  let guess = filename;
  if (!guess) { try { guess = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""); } catch { guess = undefined; } }
  const advice = playbackAdvice(guess, mimeType);
  if (!failed && !advice.risky) return null;
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied("yes"); } catch { setCopied("no"); }
  }
  return <div className={`${styles.box} ${failed ? styles.failed : ""}`} role={failed ? "alert" : "note"}>
    <strong>{failed ? "This browser could not play this file." : "This file may not play in your browser."}</strong>
    {advice.reasons.length > 0 ? <> It uses:<ul>{advice.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></> : <> Its container or codecs may not be supported here.</>}
    <p className={styles.hint}>{converted ? "The server converted this file for your browser, but it still could not be played. The stream itself is fine: " : "This file was played as it is. A server can convert files like this while you watch (the TRANSCODE setting); where that is off or not possible, "}play it in VLC or mpv, or choose a different file (an MP4 with H.264 video and AAC audio plays almost everywhere).</p>
    <div className={styles.actions}>
      <button type="button" onClick={() => void copy()}>{copied === "yes" ? "Link copied" : "Copy stream link"}</button>
      <a href={url} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">Open stream in a new tab ↗</a>
    </div>
    <p className={styles.hint} role="status">{copied === "no" ? "Your browser blocked copying; use “Open stream” and copy the address instead. " : ""}In VLC choose Media → Open Network Stream and paste it; in mpv run <code>mpv &quot;LINK&quot;</code>. The link is temporary and tied to the account that resolved it, so do not share it.</p>
  </div>;
}
