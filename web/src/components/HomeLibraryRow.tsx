"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AccountLibraryPage, AccountMedia, accountMediaName, safeMediaUrl } from "@/lib/account-library";
import styles from "./HomeLibraryRow.module.css";

/** The signed-in user's own imported debrid library, so it shows up on the home dashboard. */
export default function HomeLibraryRow({ onLoaded }: { onLoaded?: (total: number) => void }) {
  const [items, setItems] = useState<AccountMedia[] | null>(null), [total, setTotal] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<AccountLibraryPage>("/api/account/library?limit=60", { signal: controller.signal })
      .then(page => {
        if (controller.signal.aborted) return;
        // Titles with artwork first (stable otherwise), newest imports within each group.
        const withArt = (item: AccountMedia) => (safeMediaUrl(item.metadata?.posterUrl) ? 0 : 1);
        setItems([...page.items].sort((a, b) => withArt(a) - withArt(b)).slice(0, 24)); setTotal(page.total); onLoaded?.(page.total);
      })
      .catch(() => { if (!controller.signal.aborted) { setItems([]); onLoaded?.(0); } });
    return () => controller.abort();
  }, [onLoaded]);
  if (!items?.length) return null;
  return <section className={styles.section} aria-label="From your library">
    <div className={styles.head}><h2>From your library</h2><Link href="/library">See all {total.toLocaleString()} {total === 1 ? "title" : "titles"} →</Link></div>
    <div className={styles.row}>{items.map(item => {
      const name = accountMediaName(item), poster = safeMediaUrl(item.metadata?.posterUrl);
      return <Link key={item.id} href={`/library/${encodeURIComponent(item.id)}`} className={styles.card} aria-label={`Open ${name}`}>
        <div className={styles.poster}><div className={styles.fallback} aria-hidden="true"><i>{item.type === "series" ? "SERIES" : "FILM"}</i>{name}</div>{poster && <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = "none"; }} />}</div>
        <p className={styles.name}>{name}</p>
      </Link>;
    })}</div>
  </section>;
}
