export interface ProviderHealthCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastTouched: number;
}

export class ProviderHealthCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(options: ProviderHealthCacheOptions = {}) {
    this.#maxEntries = Math.max(1, Math.min(options.maxEntries ?? 32, 128));
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? 30_000, 300_000));
    this.#now = options.now ?? Date.now;
    const sweepIntervalMs = Math.max(
      1_000,
      Math.min(options.sweepIntervalMs ?? this.#ttlMs, 300_000),
    );
    this.#timer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.#timer.unref?.();
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    const now = this.#now();
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    entry.lastTouched = now;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.#closed) return;
    const now = this.#now();
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs, lastTouched: now });
    while (this.#entries.size > this.#maxEntries) {
      let oldestKey: string | undefined;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [candidateKey, entry] of this.#entries) {
        if (entry.lastTouched < oldestTouched) {
          oldestKey = candidateKey;
          oldestTouched = entry.lastTouched;
        }
      }
      if (oldestKey === undefined) break;
      this.#entries.delete(oldestKey);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#entries.clear();
  }
}
