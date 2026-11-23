/** Map with a hard size cap, TTL expiry, and oldest-first eviction. */
export class BoundedTtlMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.entries.delete(key);
    this.sweep();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export const RATE_LIMIT_FILES_PER_WINDOW = 60;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_LOGINS = 1_000;

/**
 * Fixed-window per-login file counter. State is per Worker isolate: it bounds
 * bursts against one isolate but is not a global quota (see README).
 */
export class UploadRateLimiter {
  private readonly windows: BoundedTtlMap<{ count: number; startedAt: number }>;

  constructor(
    private readonly limit = RATE_LIMIT_FILES_PER_WINDOW,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.windows = new BoundedTtlMap(RATE_LIMIT_MAX_LOGINS, windowMs, now);
  }

  /** Reserves `files` slots for `login`; returns false without reserving when the window is full. */
  tryConsume(login: string, files: number): boolean {
    const key = login.toLowerCase();
    const current = this.windows.get(key) ?? { count: 0, startedAt: this.now() };
    if (current.count + files > this.limit) return false;
    const remainingMs = Math.max(1, current.startedAt + this.windowMs - this.now());
    this.windows.set(key, { count: current.count + files, startedAt: current.startedAt }, remainingMs);
    return true;
  }
}
