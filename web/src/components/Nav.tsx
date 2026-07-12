"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { t } from "@/lib/i18n";

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const saved = (localStorage.getItem("sr_theme") as "dark" | "light") ?? "dark";
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("sr_theme", next);
    document.documentElement.dataset.theme = next;
  };
  return (
    <button className="btn-secondary btn btn-sm" onClick={toggle} title="Toggle theme">
      {theme === "dark" ? "☀️" : "🌙"}
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
