"use client";

import Link from "next/link";
import { useDownloadQueue } from "@/lib/useDownloadQueue";
import { formatBytes } from "@/lib/format";

const ACTIVE = new Set(["queued", "downloading"]);

export default function DownloadsPage() {
  const { jobs, error, busy, remove, refreshOne, clearCompleted } = useDownloadQueue();

  const hasCompleted = jobs.some((j) => j.status === "finished" || j.status === "error");

  return (
    <main className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 16px" }}>
        <div className="panel-title" style={{ margin: 0 }}>
          Download queue
        </div>
        {hasCompleted && (
          <button className="btn btn-sm" disabled={busy.has("clear")} onClick={clearCompleted}>
            clear finished/errored
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {jobs.length === 0 && <p className="dim">Queue is empty. Add something from Search.</p>}
      {jobs.map((job) => (
        <div className="job-row" key={job.id}>
          <div className="job-top">
            <span className="job-title">{job.title}</span>
            <span
              className={`pill ${
                job.status === "finished" ? "pill-ok" : job.status === "error" ? "pill-err" : "pill-warn"
              }`}
            >
              {job.status}
            </span>
          </div>
          <div className="progress-track" style={{ marginBottom: 8 }}>
            <div className="progress-fill" style={{ width: `${job.progress}%` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span className="dim" style={{ fontSize: 12 }}>
              {formatBytes(job.sizeBytes)} · {job.seeders} seeds · {job.provider}
              {job.indexerName ? ` · ${job.indexerName}` : ""}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              {job.status === "finished" && job.streamUrl && (
                <Link href={`/watch/${job.id}`} className="btn btn-sm">
                  ▶ play
                </Link>
              )}
              {ACTIVE.has(job.status) && (
                <button className="btn btn-sm" disabled={busy.has(job.id)} onClick={() => refreshOne(job.id)}>
                  refresh
                </button>
              )}
              <button className="btn btn-sm btn-danger" disabled={busy.has(job.id)} onClick={() => remove(job.id)}>
                remove
              </button>
            </div>
          </div>
          {job.error && <p className="error-text" style={{ marginTop: 8 }}>{job.error}</p>}
        </div>
      ))}
    </main>
  );
}
