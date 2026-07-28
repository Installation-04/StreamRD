import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/util/ttlCache";

describe("TtlCache", () => {
  it("returns cached values until they expire", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<number>(1000);
      cache.set("a", 1);
      expect(cache.get("a")).toBe(1);
      vi.advanceTimersByTime(1001);
      expect(cache.get("a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const cache = new TtlCache<number>(60_000, 3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Cache is full; adding a 4th distinct key evicts "a" (the oldest).
    cache.set("d", 4);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("updating an existing key doesn't count as growth", () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10); // re-set an existing key, cache stays at size 2
    cache.set("c", 3); // now a genuinely new key, evicts the oldest ("b")
    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});
