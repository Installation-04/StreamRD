"use client";

import HomeSections from "@/components/HomeSections";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { get } from "@/lib/api";
import { Icon } from "@/components/Icon";

export default function HomePage() {
  const { user } = useAuth();
  const [libraryTotal, setLibraryTotal] = useState<number | null>(null);
  const onHomeLoaded = useCallback((titles: number) => { setLibraryTotal(titles); }, []);
  const isAdmin = user?.role === "admin";
  // A server nobody has signed up on yet: the first visitor is the owner, and should be told to create the account, not to sign in.
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (user) { setFresh(false); return; }
    let live = true;
    get<{ bootstrapAvailable?: boolean }>("/api/auth/registration").then(policy => { if (live) setFresh(policy.bootstrapAvailable === true); }).catch(() => undefined);
    return () => { live = false; };
  }, [user]);
  return (
    <main className="container home-page">
      <div className="page-heading">
        <div><p className="eyebrow">YOUR PERSONAL CINEMA</p><h1>{user ? `Welcome back${user.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}.` : "Make room for a good story."}</h1><p className="page-description">{user ? "Pick up where you left off or find your next watch." : fresh ? "This server is new. Create the first account to set it up." : "Sign in to see what your server has for you."}</p></div>
      </div>
      {user ? <HomeSections onLoaded={onHomeLoaded} /> : <section className="collection-empty"><span className="empty-icon"><Icon name="film" size={28} /></span><p className="eyebrow">WELCOME</p><h2>Your server, your library.</h2>{fresh
        ? <><p>Nobody has an account here yet. The first account becomes the administrator: it connects the debrid account, builds the libraries and invites everyone else.</p><div className="feature-actions"><Link href="/signup" className="btn">Create the first account<Icon name="arrow" size={18} /></Link></div></>
        : <><p>Sign in to watch what your administrator has shared with you.</p><div className="feature-actions"><Link href="/login" className="btn">Sign in<Icon name="arrow" size={18} /></Link></div></>}</section>}
      {user && libraryTotal === 0 && <section className="collection-empty"><span className="empty-icon"><Icon name="film" size={28} /></span><p className="eyebrow">THE FIRST SCENE IS YOURS</p><h2>Let’s fill your library.</h2><p>{isAdmin ? "Connect a debrid account, import what you own, and put it in a library for your family and friends." : "Your administrator has not shared a library with you yet. You can ask for something to be added from Requests."}</p><div className="feature-actions"><Link href="/setup" className="btn">Get started<Icon name="arrow" size={18} /></Link>{isAdmin && <Link href="/library" className="btn btn-secondary"><Icon name="plus" size={18} />Import from your account</Link>}</div></section>}
      <footer className="collection-footer"><span className="footer-brand">streamrd<span> / </span>Your screen. Your story.</span><div><Link href="/setup">Getting started</Link><a href="https://github.com/Installation-04/StreamRD/wiki" target="_blank" rel="noreferrer">Community guide<Icon name="arrow" size={13} /></a></div></footer>
    </main>
  );
}
