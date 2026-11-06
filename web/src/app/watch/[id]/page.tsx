"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { FileSelection, PlaybackData, StreamInfo } from "@/lib/types";
import { PlaybackProfile } from "@/components/PlaybackProfile";
import { usePlaybackProfile } from "@/lib/usePlaybackProfile";
import { usePlaybackProgress } from "@/lib/usePlaybackProgress";
import { PROVIDER_NAMES } from "@/lib/types";

export default function WatchPage() {
  const profile = usePlaybackProfile();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playback, setPlayback] = useState<PlaybackData | null>(null);
  const progressMessage = usePlaybackProgress(videoRef, playback);
  const { id } = useParams<{ id: string }>();
  const [choice, setChoice] = useState<{ titleId: string; provider: string; sourceIndex: number; fileToken: string } | null>(null);
  const [files, setFiles] = useState<FileSelection | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [playerError, setPlayerError] = useState(false);
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [titleName, setTitleName] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile.ready) return;
    if (profile.error) { setError(profile.error); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    setPlayback(null);
    setFiles(null);
    setPlayerError(false);
    setWaiting(false);
    setStream(null);
    setError(null);
    setTitleName("");
    async function resolve() {
      try {
        const res = await api<{ stream: StreamInfo; title: { name: string }; playback?: PlaybackData }>("/api/play", {
          method: "POST", body: JSON.stringify({ titleId: id, trackProgress: true, ...(profile.profileId ? { profileId: profile.profileId } : {}), ...(choice?.titleId === id ? { sourceIndex: choice.sourceIndex, selection: { provider: choice.provider, fileToken: choice.fileToken } } : {}) }), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setPlayback(res.playback ?? null);
        setStream(res.stream);
        setTitleName(res.title.name);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.fileSelection) {
          setFiles(err.fileSelection);
          return;
        }
        if (err instanceof ApiError && err.pending && retries++ < 60) {
          setWaiting(true);
          timer = setTimeout(resolve, Math.max(1000, Math.min(30000, err.retryAfterMs)));
          return;
        }
        setError((err as Error).message);
      }
    }
    void resolve();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, choice, attempt, profile.ready, profile.profileId, profile.error]);

  return (
    <div className="player-wrap">
      <div className="player-bar">
        <Link href={`/title/${id}`} className="btn btn-secondary btn-sm">
          ← Back
        </Link>
        <strong>{titleName}</strong>
        <PlaybackProfile {...profile} onChange={profile.chooseProfile} />
        {stream && (
          <span className="dim" style={{ fontSize: 13 }}>
            via {PROVIDER_NAMES[stream.provider]}
            {stream.quality ? ` · ${stream.quality}` : ""}
          </span>
        )}
      </div>
      {progressMessage && <p role="status" style={{ padding: 16 }}>{progressMessage}</p>}
      {files ? (
        <section style={{ color: "#fff", padding: 40 }}>
          <h1>Choose a video</h1>
          <p>Choose the movie or episode you want to watch. Format support depends on your browser and the video's codecs.</p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {files.files.map(file => <li key={file.token} style={{ marginBottom: 12 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setChoice({ titleId: id, provider: files.provider, sourceIndex: files.sourceIndex, fileToken: file.token })}>
                {file.name} · {file.format.toUpperCase()}{file.size !== undefined ? ` · ${(file.size / 1024 ** 2).toFixed(1)} MB` : ""}{file.sample ? " · Sample/trailer" : ""}
              </button>
            </li>)}
          </ul>
        </section>
      ) : error ? (
        <div style={{ color: "#fff", padding: 40 }}>
          <p className="error-text">{error}</p>
          <p className="dim">
            Check your debrid configuration under Account → Debrid services, or try again
            in a moment if a torrent is still caching.
          </p>
          <button className="btn btn-secondary" onClick={() => { setChoice(null); setAttempt(value => value + 1); }}>Try again</button>
        </div>
      ) : stream ? (
        <div>
          <video ref={videoRef} src={stream.url} controls autoPlay onError={() => setPlayerError(true)} />
          {playerError && <p role="alert" style={{ padding: 16 }}>This browser could not play the selected file. <a href={stream.url} target="_blank" rel="noreferrer">Open the video link</a> to use a compatible player.</p>}
          {choice?.titleId === id && <button className="btn btn-secondary" onClick={() => setChoice(null)}>Choose another file</button>}
        </div>
      ) : (
        <div style={{ color: "#fff", padding: 40 }}>{waiting ? "Waiting for your provider to prepare the torrent…" : "Resolving stream…"}</div>
      )}
    </div>
  );
}
