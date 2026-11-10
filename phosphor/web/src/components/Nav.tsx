"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";

type PhosphorColor = "green" | "amber" | "white";
const COLORS: PhosphorColor[] = ["green", "amber", "white"];
const LABELS: Record<PhosphorColor, string> = { green: "Green", amber: "Amber", white: "White" };
function ColorToggle() {
  const [color, setColor] = useState<PhosphorColor>("green");
  useEffect(() => {
    try { const saved = localStorage.getItem("ph_color"); if (COLORS.includes(saved as PhosphorColor)) setColor(saved as PhosphorColor); } catch { /* Theme remains usable without storage. */ }
  }, []);
  function cycle() {
    const next = COLORS[(COLORS.indexOf(color) + 1) % COLORS.length];
    setColor(next); document.documentElement.dataset.phosphor = next;
    try { localStorage.setItem("ph_color", next); } catch { /* Theme still applies to this visit. */ }
  }
  return <button className="theme-switch" onClick={cycle} aria-label={`Color theme: ${LABELS[color]}. Switch to ${LABELS[COLORS[(COLORS.indexOf(color) + 1) % COLORS.length]]}.`} title="Change phosphor color"><span className="theme-dot" aria-hidden="true" />{LABELS[color]}</button>;
}
export function Nav() {
  const { user, logout } = useAuth();
  const pathname = usePathname(), router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  if (pathname.startsWith("/watch/")) return null;
  const link = (href: string, label: string) => {
    const active = pathname === href || ((href === "/admin" || href === "/library" || href === "/shared-libraries" || href === "/discover" || href === "/requests") && pathname.startsWith(`${href}/`));
    return <Link href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{label}</Link>;
  };
  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <nav className="nav" aria-label="Main navigation">
      <Link href="/" className="nav-logo"><span className="brand-symbol" aria-hidden="true">p<span>_</span></span><span>PHOSPHOR<span className="brand-caption">YOUR MEDIA. YOUR SIGNAL.</span></span></Link>
      <div className="nav-links">
        {user && link("/discover", "Find media")}{user && link("/requests", "Requests")}{user && link("/shared-libraries", "Shared libraries")}{user && link("/library", "My library")}{user && link("/setup", "Setup")}{user && link("/search", "Discover")}{user && link("/downloads", "Queue")}{user && link("/account/debrid", "Connections")}{user && link("/account/profile", "Account")}{user?.role === "admin" && link("/admin", "Admin")}
      </div>
      <div className="nav-account"><ColorToggle />{user ? <>
        <span className="nav-avatar" title={user.displayName} aria-label={user.displayName}>{user.displayName.slice(0, 1).toUpperCase()}</span>
        <button className="nav-signout" disabled={signingOut} onClick={async () => { setSigningOut(true); await logout(); router.push("/login"); }}>{signingOut ? "Signing out…" : "Sign out"}</button>
      </> : <Link href="/login" className="btn btn-sm">Sign in</Link>}</div>
    </nav>
    <span id="main-content" className="content-anchor" tabIndex={-1} />
  </>;
}
