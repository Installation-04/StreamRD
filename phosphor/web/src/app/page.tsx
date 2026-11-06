"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
export default function HomePage() {
  const { user, loading } = useAuth(), router = useRouter();
  useEffect(() => { if (!loading && user) router.replace("/search"); }, [loading, user, router]);
  if (loading || user) return <main className="container workspace"><p role="status">Opening your workspace…</p></main>;
  return <main className="container workspace"><section className="landing-console"><p className="eyebrow">A PERSONAL MEDIA TERMINAL / SELF-HOSTED</p><h1>Your media.<br />A clearer signal<span className="accent">.</span></h1><p>Bring your debrid accounts and your indexers. Discover, queue, and watch from a space that belongs to you.</p><div className="empty-actions"><Link href="/signup" className="btn btn-primary">Create your workspace ↗</Link><Link href="/login" className="btn btn-quiet">Sign in</Link></div><div className="landing-steps"><span><b>01</b> Connect your services</span><span><b>02</b> Find your next watch</span><span><b>03</b> Follow the queue</span></div></section><footer className="workspace-footer"><span>OPEN SOURCE / MADE FOR YOUR COMMUNITY</span><a href="https://github.com/Installation-04/StreamRD/wiki" target="_blank" rel="noreferrer">Community guide ↗</a></footer></main>;
}
