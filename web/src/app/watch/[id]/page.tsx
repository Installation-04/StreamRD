"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { StreamInfo } from "@/lib/types";
import { PROVIDER_NAMES } from "@/lib/types";

export default function WatchPage() {
  const { id } = useParams<{ id: string }>();
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [titleName, setTitleName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    post<{ stream: StreamInfo; title: { name: string } }>("/api/play", { titleId: id })
      .then((res) => {
        setStream(res.stream);
        setTitleName(res.title.name);
      })
      .catch((err: Error) => setError(err.message));
  }, [id]);

  return (
    <div className="player-wrap">
      <div className="player-bar">
        <Link href={`/title/${id}`} className="btn btn-secondary btn-sm">
          ← Back
        </Link>
        <strong>{titleName}</strong>
        {stream && (
          <span className="dim" style={{ fontSize: 13 }}>
            via {PROVIDER_NAMES[stream.provider]}
            {stream.quality ? ` · ${stream.quality}` : ""}
          </span>
        )}
      </div>
      {error ? (
        <div style={{ color: "#fff", padding: 40 }}>
          <p className="error-text">{error}</p>
          <p className="dim">
            Check your debrid configuration under Account → Debrid services, or try again
            in a moment if a torrent is still caching.
          </p>
        </div>
      ) : stream ? (
        <video src={stream.url} controls autoPlay />
      ) : (
        <div style={{ color: "#fff", padding: 40 }}>Resolving stream…</div>
      )}
    </div>
  );
}
