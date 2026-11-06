/**
 * Minimal in-memory TTL cache. Not shared across processes/restarts — this
 * is purely to absorb bursts of near-duplicate requests within one process
 * (e.g. a user tweaking result filters/sort without changing the search
 * query), not a durable cache layer.
 */
export class TtlCache<T> {
  private pending = new Map<string, Promise<T>>();
  private generation = 0;
  private store = new Map<string, { value: T; expiresAt: number }>();

  /**
   * @param maxEntries Once the cache holds this many keys, adding a new one
   * evicts the least-recently-set entry (Map preserves insertion order, and
   * re-setting an existing key bumps it to the back). Bounds memory growth
   * from a flood of distinct queries/indexers.
   */
  constructor(private ttlMs: number, private maxEntries = 1000) {}

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
    if (this.store.has(key)) {
      this.store.delete(key); // re-inserted below, moving it to the back
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.generation++;
    this.pending.clear();
    this.store.clear();
  }

  /** Returns the cached value, or computes, caches, and returns a fresh one. */
  async getOrSet(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const pending = Promise.resolve().then(compute).then(value => {
      // Clear invalidates work started before it.
      if (generation === this.generation) this.set(key, value);
      return value;
    });
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
}
