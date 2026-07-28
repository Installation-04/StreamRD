"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";

type PhosphorColor = "green" | "amber" | "white";

const COLOR_ORDER: PhosphorColor[] = ["green", "amber", "white"];
const COLOR_LABEL: Record<PhosphorColor, string> = { green: "GRN", amber: "AMB", white: "WHT" };

function ColorToggle() {
  const [color, setColor] = useState<PhosphorColor>("green");

  useEffect(() => {
    const saved = (localStorage.getItem("ph_color") as PhosphorColor) ?? "green";
    setColor(saved);
    if (saved !== "green") document.documentElement.dataset.phosphor = saved;
  }, []);

  const cycle = () => {
    const next = COLOR_ORDER[(COLOR_ORDER.indexOf(color) + 1) % COLOR_ORDER.length];
    setColor(next);
    localStorage.setItem("ph_color", next);
    if (next === "green") delete document.documentElement.dataset.phosphor;
    else document.documentElement.dataset.phosphor = next;
  };

  return (
    <button className="btn btn-sm" onClick={cycle} title={`Phosphor color: ${color} (click to change)`}>
      {COLOR_LABEL[color]}
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
      <ColorToggle />
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
