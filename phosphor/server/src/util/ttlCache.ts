/**
 * Minimal in-memory TTL cache. Not shared across processes/restarts — this
 * is purely to absorb bursts of near-duplicate requests within one process
 * (e.g. a user tweaking result filters/sort without changing the search
 * query), not a durable cache layer.
 */
export class TtlCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  /** Returns the cached value, or computes, caches, and returns a fresh one. */
  async getOrSet(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value);
    return value;
  }
}
