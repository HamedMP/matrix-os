/**
 * GroupDocCache — byte-bounded LRU for in-memory Y.Doc instances (spec §
 * Resource Management and T035c).
 *
 * The cache holds any value that exposes a `size` field (bytes). When the
 * total reported size exceeds `maxBytes`, the least-recently-accessed entry
 * is evicted and the registered `onEvict` listener is fired. Callers are
 * expected to transparently re-hydrate from disk on next access.
 *
 * This helper is intentionally unaware of Y.Doc specifics — it's a plain
 * bookkeeping primitive. GroupSync / GroupRegistry owns the rehydrate path.
 */

export interface Sized {
  /** Approximate size in bytes. May be recomputed by the caller. */
  size: number;
}

export interface GroupDocCacheOptions {
  maxBytes: number;
}

export class GroupDocCache<T extends Sized = Sized> {
  private readonly maxBytes: number;
  private readonly entries = new Map<string, T>();
  private totalBytesCached = 0;
  private evictListeners = new Set<(slug: string) => void>();

  constructor(options: GroupDocCacheOptions) {
    if (options.maxBytes <= 0) {
      throw new Error('GroupDocCache: maxBytes must be positive');
    }
    this.maxBytes = options.maxBytes;
  }

  /** Register an eviction listener. Caller is responsible for disposal. */
  onEvict(listener: (slug: string) => void): { dispose(): void } {
    this.evictListeners.add(listener);
    return {
      dispose: () => {
        this.evictListeners.delete(listener);
      },
    };
  }

  put(slug: string, entry: T): void {
    const existing = this.entries.get(slug);
    if (existing) {
      this.totalBytesCached -= existing.size;
      this.entries.delete(slug);
    }
    this.entries.set(slug, entry);
    this.totalBytesCached += entry.size;
    this.enforceCap();
  }

  get(slug: string): T | undefined {
    const entry = this.entries.get(slug);
    if (!entry) return undefined;
    // Bump recency by re-insertion (Map preserves insertion order).
    this.entries.delete(slug);
    this.entries.set(slug, entry);
    return entry;
  }

  has(slug: string): boolean {
    return this.entries.has(slug);
  }

  delete(slug: string): boolean {
    const entry = this.entries.get(slug);
    if (!entry) return false;
    this.totalBytesCached -= entry.size;
    this.entries.delete(slug);
    return true;
  }

  /** Recompute the cached size for an entry that has grown or shrunk. */
  updateSize(slug: string, newSize: number): void {
    const entry = this.entries.get(slug);
    if (!entry) return;
    this.totalBytesCached += newSize - entry.size;
    entry.size = newSize;
    this.enforceCap();
  }

  totalBytes(): number {
    return this.totalBytesCached;
  }

  size(): number {
    return this.entries.size;
  }

  private enforceCap(): void {
    while (this.totalBytesCached > this.maxBytes && this.entries.size > 0) {
      // Least-recently-used = oldest in insertion order.
      const firstKey = this.entries.keys().next().value as string | undefined;
      if (!firstKey) break;
      const firstEntry = this.entries.get(firstKey);
      if (!firstEntry) break;
      this.totalBytesCached -= firstEntry.size;
      this.entries.delete(firstKey);
      for (const listener of this.evictListeners) {
        try {
          listener(firstKey);
        } catch {
          // Eviction listeners must not break the cache.
        }
      }
    }
  }
}
