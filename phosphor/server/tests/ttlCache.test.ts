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


it("coalesces concurrent misses and caches the result", async () => {
  const cache = new TtlCache<number>(1000);
  const compute = vi.fn(async () => 42);
  expect(await Promise.all([cache.getOrSet("a", compute), cache.getOrSet("a", compute)])).toEqual([42, 42]);
  expect(await cache.getOrSet("a", compute)).toBe(42);
  expect(compute).toHaveBeenCalledTimes(1);
});
it("retries after a shared failure", async () => {
  const cache = new TtlCache<number>(1000);
  const compute = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(42);
  const results = await Promise.allSettled([cache.getOrSet("a", compute), cache.getOrSet("a", compute)]);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(await cache.getOrSet("a", compute)).toBe(42);
  expect(compute).toHaveBeenCalledTimes(2);
});
it("does not repopulate cleared cache from old work", async () => {
  const cache = new TtlCache<number>(1000);
  let resolve!: (value: number) => void;
  const old = cache.getOrSet("a", () => new Promise<number>(done => { resolve = done; }));
  await Promise.resolve();
  cache.clear();
  expect(await cache.getOrSet("a", async () => 2)).toBe(2);
  resolve(1);
  expect(await old).toBe(1);
  expect(cache.get("a")).toBe(2);
});
