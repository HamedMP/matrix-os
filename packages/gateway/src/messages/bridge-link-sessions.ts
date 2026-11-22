import { randomUUID } from "node:crypto";
import type { MessagingBridgeLoginStep, MessagingBridgeNetwork } from "@matrix-os/contracts/messaging-bridge";

/** In-memory bridge login attempts and per-owner rate limits. Nothing here is persisted. */

export const LINK_SESSION_TTL_MS = 10 * 60 * 1000;
export const LINK_SESSIONS_PER_OWNER = 16;
export const LINK_SESSIONS_MAX = 256;
export const LINK_ID_PATTERN = /^link_[0-9a-f]{32}$/;

export interface BridgeLinkSession {
  readonly linkId: string;
  readonly ownerId: string;
  readonly network: MessagingBridgeNetwork;
  readonly loginProcessId: string;
  readonly expiresAt: number;
  stepType: MessagingBridgeLoginStep["type"];
  stepId: string | null;
  busy: boolean;
}

function stepIdOf(step: MessagingBridgeLoginStep): string | null {
  return step.type === "display_and_wait" || step.type === "user_input" ? step.stepId : null;
}

export class BridgeLinkSessions {
  // Capped at LINK_SESSIONS_MAX overall and LINK_SESSIONS_PER_OWNER per owner; oldest evicted.
  private readonly sessions = new Map<string, BridgeLinkSession>();

  /** `onDrop` hears about sessions removed by expiry or eviction (not by an explicit delete). */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly onDrop: (session: BridgeLinkSession) => void = () => undefined,
  ) {}

  private drop(session: BridgeLinkSession): void {
    this.sessions.delete(session.linkId);
    this.onDrop(session);
  }

  create(ownerId: string, network: MessagingBridgeNetwork, loginProcessId: string, step: MessagingBridgeLoginStep): BridgeLinkSession {
    this.sweep();
    const owned = [...this.sessions.values()].filter((session) => session.ownerId === ownerId);
    for (const stale of owned.slice(0, Math.max(0, owned.length - LINK_SESSIONS_PER_OWNER + 1))) {
      this.drop(stale);
    }
    while (this.sessions.size >= LINK_SESSIONS_MAX) {
      const oldest = this.sessions.values().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    const session: BridgeLinkSession = {
      linkId: `link_${randomUUID().replaceAll("-", "")}`,
      ownerId,
      network,
      loginProcessId,
      expiresAt: this.now() + LINK_SESSION_TTL_MS,
      stepType: step.type,
      stepId: stepIdOf(step),
      busy: false,
    };
    this.sessions.set(session.linkId, session);
    return session;
  }

  /** The owner's live session, `"expired"` for the owner's expired one, otherwise null. */
  get(ownerId: string, linkId: string): BridgeLinkSession | "expired" | null {
    const session = this.sessions.get(linkId);
    if (!session || session.ownerId !== ownerId) return null;
    if (session.expiresAt <= this.now()) {
      this.drop(session);
      return "expired";
    }
    return session;
  }

  advance(session: BridgeLinkSession, step: MessagingBridgeLoginStep): void {
    session.stepType = step.type;
    session.stepId = stepIdOf(step);
  }

  delete(linkId: string): void {
    this.sessions.delete(linkId);
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= now) {
        this.drop(session);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }

  /** Shutdown: forget everything; the platform cancels abandoned logins on its own timer. */
  clear(): void {
    this.sessions.clear();
  }
}

/** Sliding-window limiter keyed by owner, with a cap on tracked keys (least recently used evicted). */
export class OwnerRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 1_024,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    this.hits.delete(key);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.hits.clear();
  }
}
