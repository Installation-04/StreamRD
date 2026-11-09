"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import SystemMaintenance from "@/components/SystemMaintenance";
import styles from "./system.module.css";

type MigrationState = "current" | "unmanaged" | "pending" | "failed" | "drifted" | "unavailable";
type SystemStatus = {
  product: string;
  version: string;
  runtime: { nodeVersion: string };
  database: { status: "up" | "down" };
  migrations: { state: MigrationState; applied: number; total: number; pending: string[]; failed: string[]; reason?: string; lastAppliedAt: string | null };
  upgrade: { automatic: boolean; backupPolicy: "verified-before-changes" };
  media: { configured: boolean };
};
const GUIDE = "https://github.com/Installation-04/StreamRD/blob/main/docs/database-upgrades.md";
const RECOVERY = "https://github.com/Installation-04/StreamRD/wiki/Operations-and-recovery";
const STATES: Record<MigrationState, { label: string; title: string; description: string; tone: "healthy" | "warning" | "critical" | "neutral" }> = {
  current: { label: "Current", title: "Database upgrades are current.", description: "Migration history reports no pending steps for this release. Keep verified backups as part of your upgrade routine.", tone: "healthy" },
  unmanaged: { label: "Unmanaged", title: "This database needs an upgrade baseline.", description: "Managed migration history is not recorded yet. Follow the supported upgrade guide to identify the existing schema, verify a snapshot, and establish its baseline.", tone: "warning" },
  pending: { label: "Pending", title: "There are database changes to prepare.", description: "This release includes migration steps that have not been applied. Follow the documented server-side preparation flow with a verified snapshot before returning writers to service.", tone: "warning" },
  failed: { label: "Needs recovery", title: "A migration needs operator attention.", description: "A recorded migration did not finish successfully. Keep writers stopped and review the recovery guide before attempting another upgrade.", tone: "critical" },
  drifted: { label: "Needs review", title: "The database and release records differ.", description: "The database schema or migration records do not match this release. Preserve the database and its backup, then review the documented recovery steps.", tone: "critical" },
  unavailable: { label: "Unavailable", title: "Migration state could not be checked.", description: "The server could not establish its migration state. Check backend availability and database access, then refresh this page.", tone: "neutral" },
};
function Symbol({ name, size = 20 }: { name: "database" | "refresh" | "arrow" | "check" | "attention"; size?: number }) {
  const paths = {
    database: "M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4ZM4 6v12c0 2.2 3.6 4 8 4s8-1.8 8-4V6M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4",
    refresh: "M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17",
    arrow: "M5 19 19 5M5 5h14v14",
    check: "m5 12 4 4L19 6",
    attention: "M12 8v5m0 3v1M12 2 2 21h20L12 2Z",
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function dateLabel(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "Not recorded";
  return new Date(value).toLocaleString();
}
function migrationLabel(value: string) {
  return /^[A-Za-z0-9_-]{1,180}$/.test(value) ? value : "Unrecognized migration record";
}
export default function SystemPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setLoading(true); setError("");
    try {
      const response = await api<SystemStatus>("/api/admin/system", { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!response?.database || !response.migrations || !Object.prototype.hasOwnProperty.call(STATES, response.migrations.state) || !response.upgrade || !response.runtime || !response.media) throw new Error("Invalid system response");
      setStatus(response); setCheckedAt(new Date().toISOString());
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof ApiError && (reason.status === 401 || reason.status === 403)
        ? "Your administrator session is no longer available. Sign in again or check your access."
        : reason instanceof ApiError && reason.status === 404
          ? "This backend does not provide system status yet. Check that the server and web app are running compatible releases."
          : "System status could not be refreshed. Check the backend connection and database access, then try again.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => active.current?.abort(); }, [load]);
  const product = status?.product === "phosphor" ? "Phosphor" : "StreamRD";
  const recorded = status ? STATES[status.migrations.state] : null;
  const databaseDown = status?.database.status === "down";
  const tone = error ? "neutral" : databaseDown ? "critical" : recorded?.tone ?? "neutral";
  const title = error ? "A fresh system check is needed." : databaseDown ? "The database is unavailable." : recorded?.title;
  const description = error ? "The last successful snapshot is shown below. Connection or access may have changed since that check."
    : databaseDown ? "The server cannot currently reach its database. Check service logs and storage access before preparing an upgrade."
      : recorded?.description;
  return <div className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>YOUR INSTALLATION / OPERATIONS</p><h2>System &amp; upgrades</h2><p className={styles.intro}>Database availability, migration records, and the guardrails for your next upgrade.</p></div>
      <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load()}><Symbol name="refresh" size={16} />{loading ? "Checking system…" : "Refresh status"}</button>
    </header>
    {error && <div className={styles.error} role="alert"><Symbol name="attention" /><div><h3>System check needs attention</h3><p>{error}</p></div><button className={styles.textButton} disabled={loading} onClick={() => void load()}>Try again</button></div>}
    {!status && loading && <div className={styles.loading} role="status"><span className={styles.loadingMark}><Symbol name="database" size={27} /></span><h3>Checking your installation</h3><p>Reading the database connection and recorded migration state…</p></div>}
    {!status && !loading && <section className={styles.empty}><h3>Your system snapshot is unavailable</h3><p>Once the backend responds, this page will show its actual upgrade state.</p><a href={GUIDE} target="_blank" rel="noreferrer">Open the operations guide <Symbol name="arrow" size={14} /></a></section>}
    {status && recorded && <div aria-busy={loading}>
      <section className={`${styles.readiness} ${styles[tone]}`} aria-label="Upgrade readiness">
        <span className={styles.statusIcon}><Symbol name={tone === "healthy" ? "check" : tone === "neutral" ? "database" : "attention"} size={25} /></span>
        <div className={styles.readinessCopy}><span className={styles.statusLabel}>{error ? "LAST SUCCESSFUL SNAPSHOT" : databaseDown ? "DATABASE UNAVAILABLE" : recorded.label}</span><h3>{title}</h3><p>{description}</p></div>
        <div className={styles.release}><span>{product}</span><strong>v{status.version}</strong><span>Node {status.runtime.nodeVersion.replace(/^v/, "")}</span></div>
      </section>
      <div className={styles.checked} role="status" aria-live="polite"><span className={styles.dot} /><span>{loading ? "Refreshing local system state…" : `${error ? "Last successful check" : "Checked"}: ${dateLabel(checkedAt)}`}</span><span>Refresh reads local system and database state.</span></div>
      <section className={styles.metrics} aria-label="System summary">
        <div className={styles.metric}><span className={styles.metricLabel}>Database connection</span><strong className={databaseDown ? styles.criticalText : styles.healthyText}>{databaseDown ? "Unavailable" : "Connected"}</strong><span>{databaseDown ? "Check storage and service access" : "Database connection responded"}</span></div>
        <div className={styles.metric}><span className={styles.metricLabel}>Recorded migrations</span><strong>{status.migrations.state === "unavailable" ? "—" : <>{status.migrations.applied}<small> / {status.migrations.total}</small></>}</strong><span>{recorded.label}</span></div>
        <div className={styles.metric}><span className={styles.metricLabel}>Startup preparation</span><strong>{status.upgrade.automatic ? "Automatic" : "Manual"}</strong><span>{status.upgrade.automatic ? "Prepares migrations during startup" : "Automatic preparation is disabled"}</span></div>
        <div className={styles.metric}><span className={styles.metricLabel}>External media library</span><strong>{status.media.configured ? "Configured" : "Optional"}</strong><span>{status.media.configured ? "Mount paths are configured" : "URL playback works without a mount"}</span></div>
      </section>
      <div className={styles.columns}>
        <section className={styles.panel} aria-labelledby="migration-heading">
          <div className={styles.panelHeading}><div><p className={styles.eyebrow}>VERSIONED DATABASE CHANGES</p><h3 id="migration-heading">Migration record</h3></div><span className={`${styles.badge} ${styles[recorded.tone]}`}>{recorded.label}</span></div>
          <dl className={styles.details}><div><dt>Applied steps</dt><dd>{["unavailable", "failed", "drifted"].includes(status.migrations.state) ? "Not verified" : status.migrations.applied}</dd></div><div><dt>Steps in this release</dt><dd>{status.migrations.state === "unavailable" ? "Unknown" : status.migrations.total}</dd></div><div><dt>Last applied</dt><dd>{dateLabel(status.migrations.lastAppliedAt)}</dd></div></dl>
          {status.migrations.pending.length > 0 && <div className={styles.migrationGroup}><h4>Pending steps <span>{status.migrations.pending.length}</span></h4><ul>{status.migrations.pending.map((name, index) => <li key={`${index}-${name}`}><span className={styles.pendingDot} /><code>{migrationLabel(name)}</code></li>)}</ul></div>}
          {status.migrations.failed.length > 0 && <div className={styles.migrationGroup}><h4>Needs recovery <span>{status.migrations.failed.length}</span></h4><ul>{status.migrations.failed.map((name, index) => <li key={`${index}-${name}`}><Symbol name="attention" size={15} /><code>{migrationLabel(name)}</code></li>)}</ul></div>}
          {status.migrations.state === "current" && !status.migrations.pending.length && !status.migrations.failed.length && <p className={styles.inlineNote}><Symbol name="check" size={16} />No pending migration steps are reported.</p>}
          {status.migrations.state === "unmanaged" && <p className={styles.inlineNote}>A baseline must be established through the supported preparation flow before migration counts can describe this database.</p>}
          <a className={styles.panelLink} href={GUIDE} target="_blank" rel="noreferrer">Review the upgrade procedure <Symbol name="arrow" size={14} /></a>
        </section>
        <section className={styles.panel} aria-labelledby="backup-heading">
          <div className={styles.panelHeading}><div><p className={styles.eyebrow}>RECOVERY COMES FIRST</p><h3 id="backup-heading">Snapshot before changes</h3></div><span className={styles.policyBadge}>Upgrade policy</span></div>
          <p className={styles.panelDescription}>The upgrade process requires a verified snapshot before changing an existing database, including establishing its first migration baseline.</p>
          <div className={styles.backupEvidence}><Symbol name="database" size={22} /><div><h4>Backup evidence is checked separately</h4><p>This page reports the configured upgrade policy. It does not confirm that a snapshot exists or that recovery has been tested for your data.</p></div></div>
          <ol className={styles.steps}><li><span>01</span><div><h4>Preserve the current installation</h4><p>Stop writers and keep a verified database snapshot with your private configuration.</p></div></li><li><span>02</span><div><h4>Prepare on the server</h4><p>Use the documented upgrade flow. Database changes are performed by the server-side preparation command.</p></div></li><li><span>03</span><div><h4>Confirm recovery</h4><p>Verify health, sign-in, and known application data before returning clients to service.</p></div></li></ol>
          <a className={styles.panelLink} href={RECOVERY} target="_blank" rel="noreferrer">Read backup &amp; recovery steps <Symbol name="arrow" size={14} /></a>
        </section>
      </div>
      <SystemMaintenance />
      <footer className={styles.footer}><div><h3>Operate deliberately.</h3><p>Keep migration recovery and private backups under your control. Provider connection tests remain on their own settings pages.</p></div><Link href="/admin/library">Manage optional media exports <Symbol name="arrow" size={14} /></Link></footer>
    </div>}
  </div>;
}
