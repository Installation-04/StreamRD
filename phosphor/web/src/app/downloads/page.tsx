"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { del, get, post } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { DownloadJob } from "@/lib/types";

const ACTIVE = new Set(["queued", "downloading"]);

export default function DownloadsPage() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<{ jobs: DownloadJob[] }>("/api/downloads")
      .then((res) => setJobs(res.jobs))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  // Poll any still-active job every 4s until it settles.
  useEffect(() => {
    const active = jobs.filter((j) => ACTIVE.has(j.status));
    if (active.length === 0) return;
    const timer = setInterval(() => {
      Promise.all(active.map((j) => post<{ job: DownloadJob }>(`/api/downloads/${j.id}/refresh`))).then(load);
    }, 4000);
    return () => clearInterval(timer);
  }, [jobs, load]);

  const remove = async (id: string) => {
    await del(`/api/downloads/${id}`);
    load();
  };

  const refreshOne = async (id: string) => {
    await post(`/api/downloads/${id}/refresh`);
    load();
  };

  const clearCompleted = async () => {
    await del("/api/downloads/clear-completed");
    load();
  };

  const hasCompleted = jobs.some((j) => j.status === "finished" || j.status === "error");

  return (
    <main className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 16px" }}>
        <div className="panel-title" style={{ margin: 0 }}>
          Download queue
        </div>
        {hasCompleted && (
          <button className="btn btn-sm" onClick={clearCompleted}>
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
                <button className="btn btn-sm" onClick={() => refreshOne(job.id)}>
                  refresh
                </button>
              )}
              <button className="btn btn-sm btn-danger" onClick={() => remove(job.id)}>
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
