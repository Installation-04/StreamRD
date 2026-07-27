"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { DownloadJob } from "@/lib/types";

export default function WatchPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ job: DownloadJob }>(`/api/downloads/${id}`)
      .then((res) => setJob(res.job))
      .catch((err: Error) => setError(err.message));
  }, [id]);

  return (
    <div className="player-wrap">
      <div className="player-bar">
        <Link href="/downloads" className="btn btn-sm">
          ← queue
        </Link>
        <strong>{job?.title ?? ""}</strong>
        {job && <span className="dim" style={{ fontSize: 12 }}>via {job.provider}</span>}
      </div>
      {error && <p className="error-text" style={{ padding: 20 }}>{error}</p>}
      {job?.streamUrl ? (
        <video src={job.streamUrl} controls autoPlay />
      ) : (
        !error && <p className="dim" style={{ padding: 20 }}>resolving stream...</p>
      )}
    </div>
  );
}
