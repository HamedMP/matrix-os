import { randomBytes } from "node:crypto";

export class MobileAppSessionTokenStore {
  private readonly tokens = new Map<string, { slug: string; expiresAt: number }>();

  constructor(private readonly options: { ttlMs: number; maxEntries: number }) {}

  mint(
    slug: string,
    now = Date.now(),
    options: { routingKey?: string } = {},
  ): { token: string; expiresAt: number } {
    this.sweep(now);
    const randomToken = randomBytes(32).toString("base64url");
    const token = options.routingKey ? `${options.routingKey}.${randomToken}` : randomToken;
    const expiresAt = now + this.options.ttlMs;
    this.tokens.set(token, { slug, expiresAt });
    while (this.tokens.size > this.options.maxEntries) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    return { token, expiresAt };
  }

  consume(slug: string, token: string, now = Date.now()): boolean {
    this.sweep(now);
    const entry = this.tokens.get(token);
    if (!entry) return false;
    this.tokens.delete(token);
    return entry.slug === slug && entry.expiresAt > now;
  }

  size(): number {
    return this.tokens.size;
  }

  private sweep(now: number): void {
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
  }
}
