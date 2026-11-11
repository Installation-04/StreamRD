"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/** Admin → Overview: options for everyone's home page. */
export default function HomeSettingsPanel() {
  const [autoplay, setAutoplay] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    api<{ autoplayTrailers: boolean }>("/api/admin/home-settings").then(result => { if (mounted.current) setAutoplay(result.autoplayTrailers); }).catch(() => { if (mounted.current) setError("Home page options could not be loaded."); });
    return () => { mounted.current = false; };
  }, []);
  async function change(next: boolean) {
    setBusy(true); setError("");
    try { const saved = await api<{ autoplayTrailers: boolean }>("/api/admin/home-settings", { method: "PUT", body: JSON.stringify({ autoplayTrailers: next }) }); if (mounted.current) setAutoplay(saved.autoplayTrailers); }
    catch { if (mounted.current) setError("That could not be saved. Try again."); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section aria-labelledby="home-options" style={{ margin: "0 0 24px" }}>
    <h2 id="home-options" style={{ fontSize: 18, margin: "0 0 8px" }}>Home page</h2>
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <input type="checkbox" checked={Boolean(autoplay)} disabled={autoplay === null || busy} onChange={event => void change(event.target.checked)} />
      <span><strong>Autoplay trailers in the banner.</strong> Featured titles play their trailer quietly behind the banner for everyone. Each browser then loads the video from YouTube. Off by default; people can still press Watch trailer.</span>
    </label>
    {error && <p role="alert" style={{ margin: "8px 0 0" }}>{error}</p>}
  </section>;
}
