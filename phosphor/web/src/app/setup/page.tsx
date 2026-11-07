"use client";
import Link from "next/link";
import AccountScanPanel from "@/components/AccountScanPanel";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { get } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import styles from "./setup.module.css";
type Check = { id: string; title: string; description: string; status: "complete" | "action" | "optional"; required: boolean; href: string | null; actionLabel: string };
type Setup = { sharedLibraries?: { libraryCount: number; readyCount: number }; product: string; role: string; configurationReady: boolean; connectionVerified: false; progress: { completed: number; total: number }; checks: Check[] };
function Arrow() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14" /></svg>; }
export default function SetupPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<Setup | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await get<Setup>("/api/account/setup")); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (!authLoading && !user) router.replace("/login"); else if (user) void load(); }, [authLoading, user, router, load]);
  if (authLoading || !user) return <main className={styles.page}><p role="status">Checking your account…</p></main>;
  const complete = data?.progress.completed ?? 0, total = data?.progress.total ?? 0;
  const sharedViewer = data?.role === "user" && (data.sharedLibraries?.libraryCount ?? 0) > 0;
  return <main className={styles.page}>
    <header className={styles.header}><div><p className={styles.eyebrow}>A little setup. A better movie night.</p><h1>Make yourself at home.</h1><p>Your library, your account and a clear path to your first watch.</p></div><Link className="btn btn-secondary" href={sharedViewer ? "/shared-libraries" : data?.product === "phosphor" ? "/search" : "/"}>Explore the app <Arrow /></Link></header>
    {error && <div className={styles.error} role="alert"><p>We couldn’t refresh your setup checklist. {error}</p><button className="btn btn-secondary" onClick={() => void load()} disabled={loading}>Try again</button></div>}
    {loading && !data && <div className={styles.skeleton} role="status">Loading your checklist…</div>}
    {data && <>
      <section className={styles.overview} aria-label="Setup progress"><div><span className={styles.overline}>YOUR SPACE, TAKING SHAPE</span><h2>{data.configurationReady ? "Your essentials are configured." : "Let’s connect the essentials."}</h2><p>{sharedViewer ? "Your administrator manages the shared media and playback connection. Open your shared libraries to choose something to watch." : data.configurationReady ? "Your local configuration is in place. Test your provider and source connections before your first watch." : "The checklist reads saved settings. With automatic import enabled, your connected account is scanned in the background to build your private library."}</p></div><div className={styles.progress}><span><b>{complete}</b> / {total}</span><label htmlFor="setup-progress">Essentials configured</label><progress aria-label="Essentials configured" id="setup-progress" value={complete} max={total || 1} /></div></section>
      <div className={styles.grid}>{data.checks.map((check, index) => <section className={`${styles.step} ${check.status === "complete" ? styles.done : ""}`} key={check.id}>
        <div className={styles.stepTop}><span className={styles.number} aria-hidden="true">{check.status === "complete" ? "✓" : String(index + 1).padStart(2, "0")}</span><span className={styles.badge}>{check.status === "complete" ? "Configured" : check.required ? "Next step" : "Optional"}</span></div><h2>{check.title}</h2><p>{check.description}</p><div className={styles.stepAction}>{check.href ? <Link href={check.href}>{check.actionLabel}<Arrow /></Link> : <span className={styles.waiting}>{check.actionLabel}</span>}</div>
      </section>)}</div>
      {!sharedViewer && <AccountScanPanel automaticStart />}
      <footer className={styles.footer}><div><h3>Your accounts. Your choices.</h3><p>Saved settings don’t verify a subscription, indexer, mount, or playable file. Use each connection’s test before relying on it. Optional Plex/Jellyfin exports never block normal URL playback.</p></div><button className="btn btn-secondary" disabled={loading} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh checklist"}</button></footer>
    </>}
    <p className={styles.community}>Building together. <a href="https://github.com/Installation-04/StreamRD/wiki" target="_blank" rel="noreferrer">Read the community guide <Arrow /></a></p>
  </main>;
}
