import { randomBytes } from "node:crypto";

/**
 * Bounded ack-token store for gated app installs.
 *
 * Ack tokens are opaque, one-time, 5-minute TTL, stored in a bounded LRU
 * keyed by (slug, principal). Cap = 32, evict oldest on overflow.
 *
 * Contract for shared ack between session and install endpoints:
 * - POST /api/apps/:slug/session calls peekAck (non-consuming)
 * - POST /api/apps/:slug/install calls consumeAck (terminal, deletes the token)
 * - Only the final caller (install) consumes; the same token survives
 *   across both endpoints in a single user flow
 */

interface AckRecord {
  token: string;
  slug: string;
  principal: string;
  expiresAt: number;
  createdAt: number;
}

const ACK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ACK_CAP = 32;

export class AckStore {
  private readonly store = new Map<string, AckRecord>();
  private readonly cap: number;
  private readonly ttlMs: number;

  constructor(opts?: { cap?: number; ttlMs?: number }) {
    this.cap = opts?.cap ?? ACK_CAP;
    this.ttlMs = opts?.ttlMs ?? ACK_TTL_MS;
  }

  private key(slug: string, principal: string): string {
    return `${slug}:${principal}`;
  }

  mint(slug: string, principal: string): { ack: string; expiresAt: number } {
    // Evict expired entries first
    this.evictExpired();

    // Evict LRU if at cap
    while (this.store.size >= this.cap) {
      const oldest = this.findOldest();
      if (oldest) {
        this.store.delete(oldest);
      } else {
        break;
      }
    }

    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    const k = this.key(slug, principal);

    this.store.set(k, {
      token,
      slug,
      principal,
      expiresAt,
      createdAt: now,
    });

    return { ack: token, expiresAt };
  }

  /**
   * Peek at an ack token without consuming it.
   * Used by the session endpoint which needs to validate the ack
   * but leave it available for the install endpoint.
   */
  peekAck(slug: string, principal: string, ack: string): AckRecord | null {
    const k = this.key(slug, principal);
    const record = this.store.get(k);
    if (!record) return null;
    if (record.token !== ack) return null;
    if (Date.now() > record.expiresAt) {
      this.store.delete(k);
      return null;
    }
    return record;
  }

  /**
   * Consume an ack token (one-time). Returns the record and immediately
   * deletes it. Used by the install endpoint as the terminal consumer.
   */
  consumeAck(slug: string, principal: string, ack: string): AckRecord | null {
    const record = this.peekAck(slug, principal, ack);
    if (!record) return null;
    const k = this.key(slug, principal);
    this.store.delete(k);
    return record;
  }

  get size(): number {
    return this.store.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, record] of this.store) {
      if (now > record.expiresAt) {
        this.store.delete(k);
      }
    }
  }

  private findOldest(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, record] of this.store) {
      if (record.createdAt < oldestTime) {
        oldestTime = record.createdAt;
        oldestKey = k;
      }
    }
    return oldestKey;
  }
}
