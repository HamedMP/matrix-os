/**
 * Short-lived, single-use machine join codes (spec 2701). Only a SHA-256 hash
 * of each code is kept, in memory: codes do not survive a gateway restart, so
 * the owner creates a new one. Capped, with expiry sweeping on every access.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const JOIN_CODE_PATTERN = /^mxj_[A-Za-z0-9_-]{32}$/;

interface Challenge {
  challengeId: string;
  nonce: string;
  revision: number;
  expiresAt: number;
}

interface Entry {
  expiresAt: number;
  challenge: Challenge | null;
}

export interface JoinCodeRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  challengeTtlMs?: number;
  maxActive?: number;
}

function digest(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export class JoinCodeRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly challengeTtlMs: number;
  private readonly maxActive: number;

  constructor(options: JoinCodeRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.min(options.ttlMs ?? 15 * 60_000, 15 * 60_000);
    this.challengeTtlMs = options.challengeTtlMs ?? 2 * 60_000;
    this.maxActive = options.maxActive ?? 8;
  }

  issue(): { code: string; expiresAt: string } {
    this.sweep();
    while (this.entries.size >= this.maxActive) {
      // Oldest first: Map preserves insertion order.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const code = `mxj_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(digest(code), { expiresAt, challenge: null });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** One live challenge per code; a new request replaces the previous one. */
  beginChallenge(code: string, revision: number): Omit<Challenge, "expiresAt"> | null {
    const entry = this.live(code);
    if (!entry) return null;
    const challenge: Challenge = {
      challengeId: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      revision,
      expiresAt: Math.min(entry.expiresAt, this.now() + this.challengeTtlMs),
    };
    entry.challenge = challenge;
    return { challengeId: challenge.challengeId, nonce: challenge.nonce, revision };
  }

  /** Single use: a matching challenge removes the code whatever happens next. */
  consume(code: string, challengeId: string): { nonce: string; revision: number } | null {
    const key = digest(code);
    const entry = this.live(code);
    const challenge = entry?.challenge;
    if (!entry || !challenge || challenge.challengeId !== challengeId || challenge.expiresAt <= this.now()) return null;
    this.entries.delete(key);
    return { nonce: challenge.nonce, revision: challenge.revision };
  }

  clear(): void {
    this.entries.clear();
  }

  /** Test visibility only: hashes and timestamps, never codes. */
  debugEntries(): Array<{ hash: string; expiresAt: number }> {
    this.sweep();
    return [...this.entries].map(([hash, entry]) => ({ hash, expiresAt: entry.expiresAt }));
  }

  private live(code: string): Entry | null {
    if (!JOIN_CODE_PATTERN.test(code)) return null;
    this.sweep();
    return this.entries.get(digest(code)) ?? null;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
