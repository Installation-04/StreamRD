"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { BrandMark } from "./BrandMark";
import { Icon, IconName } from "./Icon";

type ThemePreference = "dark" | "light" | "system";
const THEME_ORDER: ThemePreference[] = ["dark", "light", "system"];
function resolveTheme(pref: ThemePreference): "dark" | "light" {
  return pref === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
}
function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>("dark");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("sr_theme");
      const value = THEME_ORDER.includes(saved as ThemePreference) ? saved as ThemePreference : "dark";
      setPref(value); document.documentElement.dataset.theme = resolveTheme(value);
    } catch { /* The default theme still works when storage is blocked. */ }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      try { if (localStorage.getItem("sr_theme") === "system") document.documentElement.dataset.theme = resolveTheme("system"); } catch { /* No stored preference. */ }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return <button type="button" className="icon-button theme-toggle" aria-label={`Theme: ${pref}. Switch to ${THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length]} theme`} title={`Theme: ${pref}`} onClick={() => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length];
    setPref(next); document.documentElement.dataset.theme = resolveTheme(next);
    try { localStorage.setItem("sr_theme", next); } catch { /* Theme works for this visit. */ }
  }}><Icon name={pref === "dark" ? "moon" : pref === "light" ? "sun" : "screen"} size={18} /></button>;
}
export function Nav() {
  const { user, logout } = useAuth();
  // An account with a viewing limit only sees Discover (its libraries), Library and Account.
  const limited = Boolean(user && user.role !== "admin" && user.maxAge != null);
  const pathname = usePathname(), router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  if (pathname.startsWith("/play/")) return null;
  const link = (href: string, label: string, icon: IconName) => {
    const active = href === "/" ? pathname === "/" : pathname.startsWith(href.split("/").slice(0, 2).join("/"));
    return <Link href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}><Icon name={icon} size={17} /><span>{label}</span></Link>;
  };
  return <>
    <a href="#main-content" className="skip-link">Skip to content</a>
    <header className="site-header">
      <nav className="nav" aria-label="Main navigation">
        <Link href="/" className="nav-logo" aria-label="StreamRD home"><BrandMark />stream<span>rd</span></Link>
        <div className="nav-links">
          {link("/", "Discover", "home")}
          {user && !limited && link("/discover", "Find media", "search")}
          {user && !limited && link("/requests", "Requests", "film")}
          {user && link("/shared-libraries", "Library", "film")}
          {user?.role === "admin" && link("/library", "Imports", "grid")}
          {user && !limited && link("/setup", "Setup", "settings")}
          {user && link("/account/profile", t("nav.account"), "user")}
          {user?.role === "admin" && link("/admin", t("nav.admin"), "grid")}
        </div>
        <div className="nav-actions">
          <ThemeToggle />
          {user ? <>
            <Link href="/account/profile" className="nav-account" title={`Account: ${user.displayName}`}><span className="user-avatar">{user.displayName.trim().slice(0, 1).toLocaleUpperCase() || "U"}</span><span className="nav-account-name">{user.displayName}</span></Link>
            <button type="button" className="icon-button" title={t("nav.logout")} aria-label={signingOut ? "Signing out" : t("nav.logout")} disabled={signingOut} onClick={async () => { setSigningOut(true); await logout(); router.push("/login"); setSigningOut(false); }}><Icon name="logout" size={18} /></button>
          </> : <Link href="/login" className="btn btn-sm">{t("nav.login")}<Icon name="arrow" size={15} /></Link>}
        </div>
      </nav>
    </header>
  </>;
}
