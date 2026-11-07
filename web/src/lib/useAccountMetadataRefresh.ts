"use client";
import { Dispatch, SetStateAction, useEffect, useRef } from "react";
import { api } from "./api";
import { AccountMedia } from "./account-library";

/** Refresh only pending cards already loaded, preserving search, paging and scroll. */
export function useAccountMetadataRefresh(items: AccountMedia[], setItems: Dispatch<SetStateAction<AccountMedia[]>>, enabled: boolean) {
  const pending = items.filter(item => item.metadataStatus === "queued" || item.metadataStatus === "processing").map(item => item.id).join(",");
  const offset = useRef(0);
  useEffect(() => {
    if (!enabled || !pending) return;
    const ids = pending.split(",");
    let disposed = false, rounds = 0, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null;
    const schedule = () => { if (!disposed && rounds < 36 && document.visibilityState === "visible") timer = setTimeout(() => void refresh(), 5000); };
    const refresh = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      controller = new AbortController(); const active = controller;
      const selected = Array.from({ length: Math.min(5, ids.length) }, (_, index) => ids[(offset.current + index) % ids.length]);
      offset.current = (offset.current + selected.length) % ids.length;
      const results = await Promise.allSettled(selected.map(id => api<{ item: AccountMedia }>(`/api/account/library/${encodeURIComponent(id)}`, { signal: active.signal })));
      if (disposed || active.signal.aborted) return;
      const updates = new Map<string, AccountMedia>();
      for (const result of results) if (result.status === "fulfilled" && selected.includes(result.value.item.id)) updates.set(result.value.item.id, result.value.item);
      if (updates.size) setItems(current => current.map(item => updates.get(item.id) ?? item));
      rounds++; schedule();
    };
    const visibility = () => {
      clearTimeout(timer); controller?.abort();
      if (document.visibilityState === "visible") { rounds = 0; schedule(); }
    };
    schedule(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [enabled, pending, setItems]);
}
