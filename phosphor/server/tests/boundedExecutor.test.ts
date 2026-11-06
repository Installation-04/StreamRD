import { afterEach, expect, it, vi } from "vitest";
import { BoundedExecutor, CapacityError } from "../src/util/boundedExecutor";
import { fetchWithTimeout } from "../src/util/fetchTimeout";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("bounds active work, runs queued work FIFO, and releases slots after rejection", async () => {
  const pool = new BoundedExecutor(1, 2);
  let finish!: () => void;
  const seen: number[] = [];
  const first = pool.run(() => new Promise<void>(resolve => { seen.push(1); finish = resolve; }));
  const second = pool.run(async () => { seen.push(2); throw new Error("upstream failed"); });
  const rejected = expect(second).rejects.toThrow("upstream failed");
  const third = pool.run(async () => { seen.push(3); return 3; });
  await expect(pool.run(async () => 4)).rejects.toBeInstanceOf(CapacityError);
  await Promise.resolve(); expect(seen).toEqual([1]);
  finish(); await first; await rejected; expect(await third).toBe(3); expect(seen).toEqual([1, 2, 3]);
});
it("expires queued work without allowing it to run later", async () => {
  vi.useFakeTimers();
  const pool = new BoundedExecutor(1, 1, 100);
  let finish!: () => void;
  const first = pool.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const work = vi.fn(async () => 2);
  const queued = expect(pool.run(work)).rejects.toBeInstanceOf(CapacityError);
  await vi.advanceTimersByTimeAsync(100); await queued;
  finish(); await first; await Promise.resolve(); expect(work).not.toHaveBeenCalled();
});
it("times out stalled response bodies instead of holding a slot forever", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); } }))));
  const pending = expect(fetchWithTimeout("https://example.invalid", {}, 100)).rejects.toThrow("aborted");
  await vi.advanceTimersByTimeAsync(100); await pending;
});
