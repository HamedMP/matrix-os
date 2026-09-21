/**
 * S07 / T039: revocation enforcement on lease loss.
 *
 * When a direct session ends because the platform denied the actor, the
 * organization evidence expired, or the lease was revoked, the actor's
 * terminal controller is released, every sandbox runtime bound to the actor
 * in that scope is stopped, and further terminal input is refused until a
 * fresh session is admitted or the block ages out. A normal close is not a
 * revocation. Both registries are bounded.
 */
import type { DirectSessionEndReason } from "./direct-sessions.js";
import type { TerminalControlCoordinator } from "./terminal-control.js";

const DEFAULT_TTL_MS = 20 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 4_096;
/** No sandboxed shared run may outlive this; an older binding is stale and its runtime is stopped. */
const DEFAULT_RUNTIME_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1_000;
const RUNTIME_HANDLE = /^runtime_[a-f0-9]{32}$/;

export type { DirectSessionEndReason };
/** An exhausted action budget belongs to one session, not every session held by the actor. */
const REVOKING_REASONS: ReadonlySet<DirectSessionEndReason> = new Set(["expired", "denied", "revoked"]);

interface RuntimeBinding {
  scopeId: string;
  actorId: string;
  runtimeHandle: string;
}

/**
 * Bounded registry of sandbox runtimes bound to (scope, actor); stops them on
 * revocation. A binding the registry can no longer track is never dropped
 * silently: at capacity the oldest binding is evicted and its runtime stopped,
 * and a binding older than the maximum run age is swept the same way, so a
 * runtime never outlives its revocation tracking (fail closed).
 */
export class SandboxRuntimeRegistry {
  private readonly bindings = new Map<string, RuntimeBinding & { boundAt: number }>();
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    client: { stopRuntime(input: { runtimeHandle: string }): Promise<unknown> };
    maxEntries?: number;
    /** Oldest a binding may be before its runtime is stopped and the entry evicted. */
    maxAgeMs?: number;
    sweepIntervalMs?: number;
    now?: () => Date;
    /** Periodic stale sweep; disable only in tests that call `sweep()` directly. */
    startTimer?: boolean;
  }) {
    this.maxEntries = boundedInteger(options.maxEntries ?? 256, 1, 256, "registry capacity");
    this.maxAgeMs = boundedInteger(options.maxAgeMs ?? DEFAULT_RUNTIME_MAX_AGE_MS, 1_000, 7 * 24 * 60 * 60 * 1_000, "runtime max age");
    this.now = options.now ?? (() => new Date());
    const sweepIntervalMs = boundedInteger(options.sweepIntervalMs ?? DEFAULT_RUNTIME_SWEEP_INTERVAL_MS, 1_000, 60 * 60 * 1_000, "runtime sweep interval");
    if (options.startTimer !== false) {
      this.sweepTimer = setInterval(() => { this.sweep(); }, sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  get size(): number {
    return this.bindings.size;
  }

  bind(binding: RuntimeBinding): void {
    if (!RUNTIME_HANDLE.test(binding.runtimeHandle)) throw new Error("Invalid sandbox runtime handle");
    if (this.bindings.has(binding.runtimeHandle)) return;
    this.sweep();
    while (this.bindings.size >= this.maxEntries) {
      const oldest = this.bindings.keys().next().value;
      if (oldest === undefined) break;
      console.warn("[collaboration-revocation] sandbox runtime registry at capacity; stopping oldest runtime");
      this.evict(oldest);
    }
    this.bindings.set(binding.runtimeHandle, { ...binding, boundAt: this.now().getTime() });
  }

  release(runtimeHandle: string): void {
    this.bindings.delete(runtimeHandle);
  }

  /** Stops and evicts every binding older than the maximum run age; returns how many were evicted. */
  sweep(): number {
    const cutoff = this.now().getTime() - this.maxAgeMs;
    let evicted = 0;
    for (const [runtimeHandle, binding] of [...this.bindings]) {
      if (binding.boundAt > cutoff) continue;
      console.warn("[collaboration-revocation] sandbox runtime outlived the maximum run age; stopping it");
      this.evict(runtimeHandle);
      evicted += 1;
    }
    return evicted;
  }

  async stopForActor(scopeId: string, actorId: string): Promise<number> {
    let stopped = 0;
    for (const binding of [...this.bindings.values()]) {
      if (binding.scopeId !== scopeId || binding.actorId !== actorId) continue;
      this.bindings.delete(binding.runtimeHandle);
      try {
        await this.options.client.stopRuntime({ runtimeHandle: binding.runtimeHandle });
        stopped += 1;
      } catch (error: unknown) {
        console.warn("[collaboration-revocation] sandbox runtime stop failed",
          error instanceof Error ? error.name : "UnknownError");
      }
    }
    return stopped;
  }

  /** Waits for eviction stops started so far (tests and shutdown). */
  async settle(): Promise<void> {
    await this.inFlight;
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private evict(runtimeHandle: string): void {
    this.bindings.delete(runtimeHandle);
    const stop = this.options.client.stopRuntime({ runtimeHandle }).then(() => undefined, (error: unknown) => {
      console.warn("[collaboration-revocation] evicted sandbox runtime stop failed",
        error instanceof Error ? error.name : "UnknownError");
    });
    this.inFlight = this.inFlight.then(() => stop);
  }
}

export class CollaborationRevocationEnforcer {
  private readonly blocked = new Map<string, number>();
  private readonly pending = new Map<Promise<void>, true>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxPending: number;
  private inFlight = 0;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(private readonly options: {
    control: Pick<TerminalControlCoordinator, "invalidateActor">;
    runtimes?: Pick<SandboxRuntimeRegistry, "stopForActor">;
    now?: () => Date;
    ttlMs?: number;
    maxEntries?: number;
    maxPending?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = boundedInteger(options.ttlMs ?? DEFAULT_TTL_MS, 1_000, 24 * 60 * 60 * 1_000, "revocation ttl");
    this.maxEntries = boundedInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, 65_536, "revocation capacity");
    this.maxPending = boundedInteger(options.maxPending ?? 256, 1, 4_096, "pending revocation capacity");
  }

  get size(): number {
    return this.blocked.size;
  }

  get pendingSize(): number {
    return this.pending.size;
  }

  /** Plug into `DirectSessionService.onEnded`. */
  onSessionEnded(session: { scopeId: string; actorId: string; organizationId?: string }, reason: DirectSessionEndReason): void {
    if (!REVOKING_REASONS.has(reason)) return;
    if (this.inFlight++ === 0) this.idle = new Promise((resolve) => { this.resolveIdle = resolve; });
    const operation = this.revoke(session.scopeId, session.actorId).catch((error: unknown) => {
      console.warn("[collaboration-revocation] enforcement failed",
        error instanceof Error ? error.name : "UnknownError");
    });
    // Stop calls continue even if their bookkeeping entry is evicted. The
    // runtime client has its own request cap and timeout; the counter keeps
    // settle() aware of evicted work without retaining every promise.
    if (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest) this.pending.delete(oldest);
    }
    this.pending.set(operation, true);
    void operation.finally(() => {
      this.pending.delete(operation);
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        this.resolveIdle?.();
        this.resolveIdle = undefined;
      }
    });
  }

  async revoke(scopeId: string, actorId: string): Promise<void> {
    this.block(scopeId, actorId);
    this.options.control.invalidateActor(scopeId, actorId);
    if (this.options.runtimes) await this.options.runtimes.stopForActor(scopeId, actorId);
  }

  /** A fresh, verified session admission lifts the block for that actor and scope. */
  admit(scopeId: string, actorId: string): void {
    this.blocked.delete(keyFor(scopeId, actorId));
  }

  isRevoked(scopeId: string, actorId: string): boolean {
    const key = keyFor(scopeId, actorId);
    const until = this.blocked.get(key);
    if (until === undefined) return false;
    if (until <= this.now().getTime()) {
      this.blocked.delete(key);
      return false;
    }
    return true;
  }

  /** Waits for in-flight enforcement (tests and shutdown). */
  async settle(): Promise<void> {
    await this.idle;
  }

  private block(scopeId: string, actorId: string): void {
    const key = keyFor(scopeId, actorId);
    this.blocked.delete(key);
    const now = this.now().getTime();
    for (const [existing, until] of this.blocked) {
      if (until <= now) this.blocked.delete(existing);
    }
    while (this.blocked.size >= this.maxEntries) {
      const oldest = this.blocked.keys().next().value;
      if (oldest === undefined) break;
      this.blocked.delete(oldest);
    }
    this.blocked.set(key, now + this.ttlMs);
  }
}

function keyFor(scopeId: string, actorId: string): string {
  return `${scopeId}\0${actorId}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Invalid ${label}`);
  }
  return value;
}
