// Bridged-app launch token cache (FR-063): bounded LRU with a TTL safety
// margin so a token isn't reused right before it expires.

export interface LaunchToken {
  launchUrl: string;
  expiresAt: number;
}

const TTL_MARGIN_MS = 30_000;
const DEFAULT_CAP = 32;

export class LaunchTokenCache {
  private readonly entries = new Map<string, LaunchToken>();
  private readonly cap: number;
  private readonly clock: () => number;

  constructor(options?: { cap?: number; clock?: () => number }) {
    this.cap = options?.cap ?? DEFAULT_CAP;
    this.clock = options?.clock ?? Date.now;
  }

  get(slug: string): LaunchToken | null {
    const token = this.entries.get(slug);
    if (!token) return null;
    if (this.clock() > token.expiresAt - TTL_MARGIN_MS) {
      this.entries.delete(slug);
      return null;
    }
    // Refresh recency.
    this.entries.delete(slug);
    this.entries.set(slug, token);
    return token;
  }

  set(slug: string, token: LaunchToken): void {
    if (this.entries.has(slug)) this.entries.delete(slug);
    this.entries.set(slug, token);
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(slug: string): void {
    this.entries.delete(slug);
  }

  clear(): void {
    this.entries.clear();
  }
}
