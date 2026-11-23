/**
 * Pull request summaries per task branch (spec 2699 section 4, Resource
 * management): at most 500 entries, 60 s TTL, least recently used eviction.
 * Only filled when a viewer asks; nothing refreshes in the background.
 */
import type { PullRequestLookup } from "./session-ports.js";

export const PR_CACHE_LIMITS = { entries: 500, ttlMs: 60_000 } as const;

export class PullRequestCache {
  private readonly entries = new Map<string, { value: PullRequestLookup; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number = PR_CACHE_LIMITS.entries,
    private readonly ttlMs: number = PR_CACHE_LIMITS.ttlMs,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): PullRequestLookup | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    // Re-insert so iteration order stays least recently used first.
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: PullRequestLookup): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
