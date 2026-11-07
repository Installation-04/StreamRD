"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ACCOUNT_PROVIDER_NAMES, AccountProvider, AccountScans } from "@/lib/account-library";
import styles from "./AccountScanPanel.module.css";

const LABELS = { "not-started": "Not scanned", queued: "Queued", scanning: "Scanning", complete: "Scanned", error: "Needs attention", cancelled: "Stopped" };
export default function AccountScanPanel({ automaticStart = false, onChanged }: { automaticStart?: boolean; onChanged?: (imported: number) => void }) {
  const [data, setData] = useState<AccountScans | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const mounted = useRef(false), active = useRef<AbortController | null>(null), operation = useRef<AbortController | null>(null), started = useRef(new Set<string>()), changeCallback = useRef(onChanged), imported = useRef(-1);
  changeCallback.current = onChanged;
  const load = useCallback(async (quiet = false) => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    if (!quiet) setLoading(true);
    try {
      const response = await api<AccountScans>("/api/account/library/scans", { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      setData(response); setError("");
      if (imported.current !== response.totalImported) { imported.current = response.totalImported; changeCallback.current?.(response.totalImported); }
    } catch { if (!controller.signal.aborted && mounted.current) setError("We couldn’t check your account scan. Check the connection and try again."); }
    finally { if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }, []);
  const run = useCallback(async (provider?: AccountProvider, force = true, cancel = false) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      const response = await api<{ queued?: number }>(cancel ? "/api/account/library/scan/cancel" : "/api/account/library/scan", {
        method: "POST", signal: controller.signal, body: JSON.stringify(cancel ? { provider } : { ...(provider ? { provider } : {}), force }),
      });
      if (controller.signal.aborted || !mounted.current) return;
      setNotice(cancel ? "Scan stopped. Already imported titles stay in your library." : response.queued ? "Your scan is queued. Existing torrents will appear here as they are imported." : "Your connected accounts are already scanned or a scan is running.");
      await load(true);
    } catch (reason) { if (!controller.signal.aborted && mounted.current) setError(reason instanceof Error ? reason.message : "The scan could not be started. Try again."); }
    finally { if (operation.current === controller) operation.current = null; if (mounted.current && !controller.signal.aborted) setBusy(false); }
  }, [load]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; active.current?.abort(); operation.current?.abort(); }; }, [load]);
  useEffect(() => {
    if (!automaticStart || !data?.automatic || busy) return;
    const eligible = data.providers.filter(provider => provider.configured && provider.enabled && provider.status === "not-started" && !started.current.has(provider.provider));
    if (!eligible.length) return;
    // One idempotent start request per onboarding visit. Polling never restarts a
    // completed, stopped or failed scan; the server owns durable continuation.
    eligible.forEach(provider => started.current.add(provider.provider)); void run(undefined, false);
  }, [automaticStart, data, busy, run]);
  const scanning = Boolean(data?.providers.some(provider => provider.status === "queued" || provider.status === "scanning"));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
    const schedule = () => { if (!disposed && scanning && document.visibilityState === "visible") timer = setTimeout(async () => { await load(true); schedule(); }, 2500); };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === "visible") { void load(true); schedule(); } };
    schedule(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [scanning, load]);
  const eligible = data?.providers.some(provider => provider.configured && provider.enabled);
  return <section className={styles.panel} aria-label="Your account library scan">
    <header className={styles.header}><div><p className={styles.eyebrow}>YOUR ACCOUNT / YOUR LIBRARY</p><h2>Bring what’s already yours.</h2><p>Scan existing torrents in your connected accounts and add them to your private web library.</p></div><Link href="/library" className="btn btn-secondary">Open my library <span aria-hidden="true">↗</span></Link></header>
    {error && <div className={styles.error} role="alert"><p>{error}</p><button type="button" disabled={busy || loading} onClick={() => void load()}>Try again</button></div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {loading && !data && <p className={styles.loading} role="status">Checking saved scan progress…</p>}
    {data && <>
      <div className={styles.summary}><div><strong>{data.totalImported}</strong><span>{data.totalImported === 1 ? "title in your library" : "titles in your library"}</span></div><p>{data.automatic ? "Automatic import is on. Connecting an account queues a scan; this onboarding page can start one for an existing connection." : "Automatic import is off. You can start a scan here or enable it in Connections."}</p></div>
      <div className={styles.providers}>{data.providers.map(provider => {
        const activeScan = provider.status === "queued" || provider.status === "scanning";
        return <article className={styles.provider} key={provider.provider} aria-label={`${ACCOUNT_PROVIDER_NAMES[provider.provider]} library scan`}>
          <div className={styles.providerTitle}><h3>{ACCOUNT_PROVIDER_NAMES[provider.provider]}</h3><span className={`${styles.badge} ${activeScan ? styles.running : provider.status === "complete" ? styles.complete : ""}`}>{!provider.configured ? "No saved key" : !provider.enabled ? "Disabled" : LABELS[provider.status]}</span></div>
          <p className={styles.counts}>{provider.scanned} checked <span>·</span> {provider.imported} imported <span>·</span> {provider.skipped} already known or skipped</p>
          {provider.error && <p className={styles.providerError}>{provider.error}</p>}
          <div className={styles.providerAction}>{!provider.configured ? <Link href="/account/debrid">Connect account ↗</Link> : !provider.enabled ? <span>Ask your administrator to enable this provider.</span> : <button type="button" disabled={busy} aria-label={`${activeScan ? "Stop" : "Scan"} ${ACCOUNT_PROVIDER_NAMES[provider.provider]} library`} onClick={() => void run(provider.provider, true, activeScan)}>{activeScan ? "Stop scan" : provider.status === "not-started" ? "Start scan" : "Scan again"}</button>}</div>
        </article>;
      })}</div>
      <footer className={styles.footer}><p>Scans read existing account entries. They do not add or delete torrents, copy media, or publish your account’s library to other users. Playback links are resolved when you choose Play.</p><button type="button" className="btn btn-secondary" disabled={busy || !eligible} onClick={() => void run()}>Scan connected accounts</button></footer>
    </>}
  </section>;
}
