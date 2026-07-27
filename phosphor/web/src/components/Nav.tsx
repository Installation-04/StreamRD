"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

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
      <Link href="/" className="nav-logo glow">
        PHOSPHOR
      </Link>
      <div className="nav-links">
        {user && link("/search", "Search")}
        {user && link("/downloads", "Queue")}
        {user && link("/account/debrid", "Debrid")}
        {user && link("/account/profile", "Profile")}
        {user?.role === "admin" && link("/admin", "Admin")}
      </div>
      {user ? (
        <>
          <span className="dim" style={{ fontSize: 12 }}>
            {user.displayName}
          </span>
          <button
            className="btn btn-sm"
            onClick={async () => {
              await logout();
              router.push("/login");
            }}
          >
            Sign out
          </button>
        </>
      ) : (
        <Link href="/login" className="btn btn-sm" style={{ display: "inline-block" }}>
          Sign in
        </Link>
      )}
    </nav>
  );
}
