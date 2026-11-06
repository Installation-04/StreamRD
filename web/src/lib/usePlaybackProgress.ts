"use client";
import { RefObject, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { PlaybackData } from "./types";

/** Periodic saves plus best-effort final flush; no progress is recorded before playing. */
export function usePlaybackProgress(videoRef: RefObject<HTMLVideoElement>, playback: PlaybackData | null) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setMessage(null);
    const video = videoRef.current;
    if (!video || !playback) return;
    let started = false, resumed = false, closed = false, stopped = false, sending = false;
    let sequence = 0, lastSent = 0;
    type Snapshot = { positionSeconds: number; durationSeconds: number };
    let pending: Snapshot | null = null, saved: Snapshot | null = null;
    const sessionId = playback.sessionId;
    async function drain() {
      if (sending || stopped) return;
      sending = true;
      try {
        while (pending && !stopped) {
          const snapshot: Snapshot = pending; pending = null;
          try {
            const result = await api<{ accepted: boolean; reason?: string }>("/api/play/progress", {
              method: "PUT", keepalive: true, body: JSON.stringify({ sessionId, sequence: sequence++, ...snapshot }),
            });
            if (!result.accepted && result.reason === "superseded") {
              stopped = true;
              if (!closed) setMessage("Progress is being saved from another player.");
            } else {
              saved = snapshot;
              if (!closed) setMessage(null);
            }
          } catch (err) {
            if (err instanceof ApiError && [401, 404, 410].includes(err.status)) stopped = true;
            pending ??= snapshot;
            if (!closed) setMessage("Progress could not be saved. Check your connection or reload the player.");
            break; // retry on a later player event, never spin on a failed request
          }
        }
      } finally { sending = false; }
    }
    function save(force = false) {
      if (!started || stopped || !Number.isFinite(video!.duration) || video!.duration <= 0 || video!.seeking) return;
      if (!force && Date.now() - lastSent < 15000) return;
      const snapshot = { positionSeconds: Math.max(0, Math.min(video!.currentTime, video!.duration)), durationSeconds: video!.duration };
      if (saved?.positionSeconds === snapshot.positionSeconds && saved.durationSeconds === snapshot.durationSeconds) return;
      lastSent = Date.now(); pending = snapshot; void drain();
    }
    function resume() {
      if (resumed || !Number.isFinite(video!.duration) || video!.duration <= 0) return;
      resumed = true;
      if (playback!.resumeSeconds > 0) video!.currentTime = Math.min(playback!.resumeSeconds, Math.max(0, video!.duration - 1));
    }
    const playing = () => { resume(); started = true; save(true); };
    const tick = () => save();
    const flush = () => save(true);
    const visibility = () => { if (document.visibilityState === "hidden") flush(); };
    video.addEventListener("loadedmetadata", resume);
    video.addEventListener("playing", playing);
    video.addEventListener("timeupdate", tick);
    for (const event of ["pause", "seeked", "ended"]) video.addEventListener(event, flush);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", flush);
    if (video.readyState >= 1) resume();
    return () => {
      flush(); closed = true;
      video.removeEventListener("loadedmetadata", resume);
      video.removeEventListener("playing", playing);
      video.removeEventListener("timeupdate", tick);
      for (const event of ["pause", "seeked", "ended"]) video.removeEventListener(event, flush);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [videoRef, playback?.sessionId]);
  return message;
}
