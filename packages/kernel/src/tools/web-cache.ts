interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface WebCacheOptions {
  defaultTtlMs?: number;
}

export class WebCache {
  private store = new Map<string, CacheEntry>();
  private defaultTtlMs: number;

  constructor(opts: WebCacheOptions = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 15 * 60 * 1000;
  }

  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    this.evictExpired();
    return this.store.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  static normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hostname = parsed.hostname.toLowerCase();
      if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      parsed.searchParams.sort();
      return parsed.toString();
    } catch {
      return url;
    }
  }
}
