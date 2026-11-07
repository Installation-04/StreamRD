"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

const NAV = [
  { href: "/admin/shared-libraries", label: "Shared libraries" },
  { href: "/admin/metadata", label: "Metadata" },
  { href: "/admin/system", label: "System" },
  { href: "/admin/library", label: "Plex / Jellyfin" },
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/indexers", label: "Indexers" },
  { href: "/admin/server", label: "Server" },
  { href: "/admin/providers", label: "Providers" },
  { href: "/admin/logs", label: "Logs" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user?.role !== "admin") router.replace("/");
  }, [loading, user, router]);

  if (loading || user?.role !== "admin") {
    return <main className="container"><p className="dim" style={{ marginTop: 40 }}>checking permissions...</p></main>;
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
          <h1 className="glow" style={{ fontSize: 20, letterSpacing: 2, textTransform: "uppercase" }}>
            Admin
          </h1>
          <span className="dim" style={{ fontSize: 12 }}>
            {user.displayName} · <span className="pill pill-ok">admin</span>
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}
