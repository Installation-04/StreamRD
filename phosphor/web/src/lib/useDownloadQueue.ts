"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { DownloadJob } from "./types";
const ACTIVE = new Set(["queued", "downloading"]);
const fingerprint = (jobs: DownloadJob[]) => JSON.stringify(jobs.map(job => [job.id, job.status, job.progress, job.streamUrl, job.error]));

export function useDownloadQueue() {
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const actions = useRef<{ remove: (id: string) => void; refresh: (id: string) => void; clear: () => void; reload: () => void } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let closed = false, cycleQueued = false, rerun = false, delay = 4000;
    let rotation: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: DownloadJob[] = [];
    let serial = Promise.resolve();
    const locks = new Set<string>();
    const call = <T,>(path: string, method = "GET") => api<T>(path, { method, signal: controller.signal });
    const update = (list: DownloadJob[]) => { current = list; if (!closed) setJobs(list); };
    const merge = (job: DownloadJob) => update(current.map(old => old.id === job.id ? job : old));
    function enqueue(task: () => Promise<void>) {
      serial = serial.catch(() => {}).then(async () => { if (!closed) await task(); });
      void serial.catch(() => {}); // each task owns its user-facing error handling
    }
    function schedule(ms: number) {
      clearTimeout(timer);
      if (!closed && !document.hidden) timer = setTimeout(requestCycle, ms);
    }
    function requestCycle() {
      if (closed || document.hidden) return;
      clearTimeout(timer);
      if (cycleQueued) { rerun = true; return; }
      cycleQueued = true;
      enqueue(async () => {
        if (closed || document.hidden) { cycleQueued = false; return; }
        let failed = false, retryAfter = 0, fatal = false;
        const before = fingerprint(current);
        const errors: string[] = [];
        try {
          update((await call<{ jobs: DownloadJob[] }>("/api/downloads")).jobs);
          const active = current.filter(job => ACTIVE.has(job.status));
          const byId = new Map(active.map(job => [job.id, job]));
          rotation = rotation.filter(id => byId.has(id));
          for (const job of active) if (!rotation.includes(job.id)) rotation.push(job.id);
          const batchIds = rotation.splice(0, 12);
          rotation.push(...batchIds);
          const batch = batchIds.map(id => byId.get(id)!);
          let index = 0;
          await Promise.all(Array.from({ length: Math.min(3, batch.length) }, async () => {
            while (!closed && !document.hidden && locks.size === 0 && index < batch.length) {
              const job = batch[index++];
              try { merge((await call<{ job: DownloadJob }>(`/api/downloads/${job.id}/refresh`, "POST")).job); }
              catch (err) {
                failed = true;
                if (err instanceof ApiError) {
                  if (err.job) merge(err.job);
                  if (err.status === 404) update(current.filter(old => old.id !== job.id));
                  retryAfter = Math.max(retryAfter, err.retryAfterMs);
                  fatal ||= err.status === 401;
                }
                errors.push((err as Error).message);
              }
            }
          }));
        } catch (err) {
          failed = true; fatal = err instanceof ApiError && err.status === 401;
          errors.push((err as Error).message);
        } finally {
          if (!closed) { setError(errors.length ? [...new Set(errors)].join("; ") : null); setLoading(false); }
          delay = failed || before === fingerprint(current) ? Math.min(60000, delay * 2) : 4000;
          delay = Math.max(delay, Math.min(60000, retryAfter));
          cycleQueued = false;
          if (!closed && !fatal) {
            if (rerun) { rerun = false; schedule(0); }
            else if (failed || current.some(job => ACTIVE.has(job.status))) schedule(delay);
          }
        }
      });
    }
    function mutate(key: string, task: () => Promise<void>) {
      if (closed || locks.has(key)) return;
      locks.add(key); setBusy(new Set(locks)); clearTimeout(timer);
      enqueue(async () => {
        try { await task(); if (!closed) setError(null); }
        catch (err) {
          if (err instanceof ApiError && err.job) merge(err.job);
          if (!closed) setError((err as Error).message);
        } finally {
          locks.delete(key); if (!closed) { setBusy(new Set(locks)); delay = 4000; requestCycle(); }
        }
      });
    }
    actions.current = {
      reload: requestCycle,
      remove: id => mutate(id, async () => { await call(`/api/downloads/${id}`, "DELETE"); update(current.filter(job => job.id !== id)); }),
      refresh: id => mutate(id, async () => { merge((await call<{ job: DownloadJob }>(`/api/downloads/${id}/refresh`, "POST")).job); }),
      clear: () => mutate("clear", async () => { await call("/api/downloads/clear-completed", "DELETE"); update(current.filter(job => ACTIVE.has(job.status))); }),
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) { delay = 4000; requestCycle(); }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", visibility);
    requestCycle();
    return () => {
      closed = true; controller.abort(); clearTimeout(timer); actions.current = null;
      document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", visibility);
    };
  }, []);
  return { jobs, error, busy, loading, reload: () => actions.current?.reload(), remove: (id: string) => actions.current?.remove(id), refreshOne: (id: string) => actions.current?.refresh(id), clearCompleted: () => actions.current?.clear() };
}
