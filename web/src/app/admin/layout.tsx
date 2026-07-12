"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { t } from "@/lib/i18n";

const NAV = [
  { href: "/admin", label: t("admin.overview") },
  { href: "/admin/users", label: t("admin.users") },
  { href: "/admin/catalog", label: t("admin.catalog") },
  { href: "/admin/server", label: t("admin.server") },
  { href: "/admin/providers", label: t("admin.providers") },
  { href: "/admin/logs", label: t("admin.logs") },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // Client-side gate on top of the middleware redirect; the API enforces
  // the real RBAC either way.
  useEffect(() => {
    if (!loading && user?.role !== "admin") router.replace("/");
  }, [loading, user, router]);

  if (loading || user?.role !== "admin") {
    return <main className="container"><p className="dim" style={{ marginTop: 40 }}>Checking permissions…</p></main>;
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className={pathname === item.href ? "active" : ""}>
            {item.label}
          </Link>
        ))}
      </aside>
      <div className="admin-main">
        <div className="admin-topbar">
          <h1 style={{ fontSize: 22 }}>Admin</h1>
          <span className="dim" style={{ fontSize: 14 }}>
            {user.displayName} · <span className="pill pill-ok">admin</span>
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}
