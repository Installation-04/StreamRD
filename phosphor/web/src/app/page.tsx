"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace("/search");
  }, [loading, user, router]);

  if (loading) return null;

  return (
    <main className="container" style={{ marginTop: "12vh", textAlign: "center" }}>
      <h1 className="glow" style={{ fontSize: 42, letterSpacing: 6, marginBottom: 10 }}>
        PHOSPHOR
      </h1>
      <p className="dim cursor" style={{ marginBottom: 30 }}>
        connect your debrid accounts // search // stream
      </p>
      <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
        <Link href="/login" className="btn">
          Sign in
        </Link>
        <Link href="/signup" className="btn">
          Create account
        </Link>
      </div>
    </main>
  );
}
