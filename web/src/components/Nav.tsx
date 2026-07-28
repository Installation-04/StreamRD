"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { t } from "@/lib/i18n";

type ThemePreference = "dark" | "light" | "system";

const THEME_ORDER: ThemePreference[] = ["dark", "light", "system"];
const THEME_ICON: Record<ThemePreference, string> = { dark: "🌙", light: "☀️", system: "🖥️" };

function resolveTheme(pref: ThemePreference): "dark" | "light" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>("dark");

  useEffect(() => {
    const saved = (localStorage.getItem("sr_theme") as ThemePreference) ?? "dark";
    setPref(saved);
    document.documentElement.dataset.theme = resolveTheme(saved);

    // While "system" is active, follow live OS theme changes without a reload.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (localStorage.getItem("sr_theme") === "system") {
        document.documentElement.dataset.theme = resolveTheme("system");
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const cycle = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length];
    setPref(next);
    localStorage.setItem("sr_theme", next);
    document.documentElement.dataset.theme = resolveTheme(next);
  };

  return (
    <button className="btn-secondary btn btn-sm" onClick={cycle} title={`Theme: ${pref} (click to change)`}>
      {THEME_ICON[pref]}
    </button>
  );
}

export function Nav() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  if (pathname.startsWith("/watch/")) return null;

  const link = (href: string, label: string) => (
    <Link href={href} className={pathname === href ? "active" : ""}>
      {label}
    </Link>
  );

  return (
    <nav className="nav">
      <Link href="/" className="nav-logo">
        STREAMRD
      </Link>
      <div className="nav-links">
        {link("/", t("nav.home"))}
        {link("/search", t("nav.search"))}
        {user && link("/account/profile", t("nav.account"))}
        {user?.role === "admin" && link("/admin", t("nav.admin"))}
      </div>
      <ThemeToggle />
      {user ? (
        <>
          <span className="dim" style={{ fontSize: 14 }}>
            {user.displayName}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              await logout();
              router.push("/login");
            }}
          >
            {t("nav.logout")}
          </button>
        </>
      ) : (
        <Link href="/login" className="btn btn-sm" style={{ display: "inline-block" }}>
          {t("nav.login")}
        </Link>
      )}
    </nav>
  );
}
