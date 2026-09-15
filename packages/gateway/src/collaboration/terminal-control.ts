import type { CollaborationRole } from "@matrix-os/contracts";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_SWEEP_MS = 5_000;
const DEFAULT_MAX_SESSIONS = 256;

export type CollaborationTerminalControlErrorCode =
  | "forbidden"
  | "held"
  | "stale_lease"
  | "capacity"
  | "closed";

export class CollaborationTerminalControlError extends Error {
  constructor(public readonly code: CollaborationTerminalControlErrorCode) {
    super("Shared terminal control is unavailable");
    this.name = "CollaborationTerminalControlError";
  }
}

export interface TerminalControlIdentity {
  scopeId: string;
  terminalId: string;
  incarnation: string;
  actorId: string;
  role: CollaborationRole;
  connectionId: string;
}

export interface TerminalControlLease {
  actorId: string;
  connectionId: string;
  epoch: number;
  expiresAt: string;
}

interface TerminalControlEntry {
  scopeId: string;
  terminalId: string;
  incarnation: string;
  epoch: number;
  lease: (TerminalControlLease & { disconnected: boolean }) | null;
  lastTouchedAt: number;
}

export type TerminalControlChangedEvent = {
  scopeId: string;
  terminalId: string;
  incarnation: string;
  lease: TerminalControlLease | null;
};

export class TerminalControlCoordinator {
  private readonly entries = new Map<string, TerminalControlEntry>();
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxSessions: number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly options: {
    now?: () => Date;
    leaseMs?: number;
    sweepMs?: number;
    maxSessions?: number;
    startTimer?: boolean;
    onChanged?: (event: TerminalControlChangedEvent) => void | Promise<void>;
  } = {}) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = boundedInteger(options.leaseMs ?? DEFAULT_LEASE_MS, 1, 120_000, "lease");
    this.maxSessions = boundedInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 1, 256, "capacity");
    const sweepMs = boundedInteger(options.sweepMs ?? DEFAULT_SWEEP_MS, 100, 60_000, "sweep");
    this.sweepTimer = options.startTimer === false ? undefined : setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer?.unref?.();
  }

  get size(): number {
    return this.entries.size;
  }

  async acquire(identity: TerminalControlIdentity): Promise<TerminalControlLease> {
    this.assertOpen();
    requireControllerRole(identity.role);
    const entry = this.entry(identity);
    this.expireEntry(entry);
    if (entry.lease) {
      if (sameHolder(entry.lease, identity)) return publicLease(entry.lease);
      throw new CollaborationTerminalControlError("held");
    }
    return this.assign(entry, identity);
  }

  async takeover(identity: TerminalControlIdentity): Promise<TerminalControlLease> {
    this.assertOpen();
    if (identity.role !== "owner") throw new CollaborationTerminalControlError("forbidden");
    const entry = this.entry(identity);
    this.expireEntry(entry);
    if (entry.lease && sameHolder(entry.lease, identity)) return publicLease(entry.lease);
    return this.assign(entry, identity);
  }

  async renew(identity: TerminalControlIdentity & { epoch: number }): Promise<TerminalControlLease> {
    const entry = this.requireHeld(identity);
    entry.lease!.expiresAt = new Date(this.now().getTime() + this.leaseMs).toISOString();
    entry.lease!.disconnected = false;
    entry.lastTouchedAt = this.now().getTime();
    this.changed(entry);
    return publicLease(entry.lease!);
  }

  async release(identity: TerminalControlIdentity & { epoch: number }): Promise<void> {
    const entry = this.requireHeld(identity);
    entry.lease = null;
    entry.lastTouchedAt = this.now().getTime();
    this.changed(entry);
  }

  async assertHeld(identity: TerminalControlIdentity & { epoch: number }): Promise<TerminalControlLease> {
    return publicLease(this.requireHeld(identity).lease!);
  }

  current(scopeId: string, terminalId: string, incarnation: string): TerminalControlLease | null {
    const entry = this.entries.get(keyFor(scopeId, terminalId, incarnation));
    if (!entry) return null;
    this.touch(entry);
    this.expireEntry(entry);
    return entry.lease ? publicLease(entry.lease) : null;
  }

  markDisconnected(scopeId: string, connectionId: string): void {
    if (this.closed) return;
    for (const entry of [...this.entries.values()]) {
      if (entry.scopeId === scopeId && entry.lease?.connectionId === connectionId) {
        entry.lease.disconnected = true;
        this.touch(entry);
      }
    }
  }

  invalidateActor(scopeId: string, actorId: string): void {
    if (this.closed) return;
    for (const entry of [...this.entries.values()]) {
      if (entry.scopeId === scopeId && entry.lease?.actorId === actorId) this.invalidate(entry);
    }
  }

  invalidateScope(scopeId: string): void {
    if (this.closed) return;
    for (const entry of [...this.entries.values()]) {
      if (entry.scopeId === scopeId && entry.lease) this.invalidate(entry);
    }
  }

  sweep(): number {
    if (this.closed) return 0;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      const expired = this.expireEntry(entry);
      if (expired && !entry.lease) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const entry of this.entries.values()) {
      if (entry.lease) {
        entry.epoch += 1;
        entry.lease = null;
        this.changed(entry);
      }
    }
    this.entries.clear();
  }

  private entry(identity: TerminalControlIdentity): TerminalControlEntry {
    const key = keyFor(identity.scopeId, identity.terminalId, identity.incarnation);
    const current = this.entries.get(key);
    if (current) {
      this.touch(current);
      return current;
    }
    if (this.entries.size >= this.maxSessions) this.evictInactive();
    if (this.entries.size >= this.maxSessions) throw new CollaborationTerminalControlError("capacity");
    const entry: TerminalControlEntry = {
      scopeId: identity.scopeId,
      terminalId: identity.terminalId,
      incarnation: identity.incarnation,
      epoch: 0,
      lease: null,
      lastTouchedAt: this.now().getTime(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private requireHeld(identity: TerminalControlIdentity & { epoch: number }): TerminalControlEntry {
    this.assertOpen();
    requireControllerRole(identity.role);
    const entry = this.entries.get(keyFor(identity.scopeId, identity.terminalId, identity.incarnation));
    if (!entry) throw new CollaborationTerminalControlError("stale_lease");
    this.expireEntry(entry);
    if (!entry.lease || entry.lease.epoch !== identity.epoch || !sameHolder(entry.lease, identity)) {
      throw new CollaborationTerminalControlError("stale_lease");
    }
    this.touch(entry);
    return entry;
  }

  private assign(entry: TerminalControlEntry, identity: TerminalControlIdentity): TerminalControlLease {
    entry.epoch += 1;
    entry.lease = {
      actorId: identity.actorId,
      connectionId: identity.connectionId,
      epoch: entry.epoch,
      expiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      disconnected: false,
    };
    this.touch(entry);
    this.changed(entry);
    return publicLease(entry.lease);
  }

  private expireEntry(entry: TerminalControlEntry): boolean {
    if (!entry.lease || Date.parse(entry.lease.expiresAt) > this.now().getTime()) return false;
    entry.epoch += 1;
    entry.lease = null;
    entry.lastTouchedAt = this.now().getTime();
    this.changed(entry);
    return true;
  }

  private invalidate(entry: TerminalControlEntry): void {
    entry.epoch += 1;
    entry.lease = null;
    entry.lastTouchedAt = this.now().getTime();
    this.changed(entry);
  }

  private evictInactive(): void {
    for (const [key, entry] of this.entries) {
      this.expireEntry(entry);
      if (!entry.lease) {
        this.entries.delete(key);
        return;
      }
    }
  }

  private touch(entry: TerminalControlEntry): void {
    entry.lastTouchedAt = this.now().getTime();
    const key = keyFor(entry.scopeId, entry.terminalId, entry.incarnation);
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private changed(entry: TerminalControlEntry): void {
    if (!this.options.onChanged) return;
    void Promise.resolve(this.options.onChanged({
      scopeId: entry.scopeId,
      terminalId: entry.terminalId,
      incarnation: entry.incarnation,
      lease: entry.lease ? publicLease(entry.lease) : null,
    })).catch((error: unknown) => {
      console.warn(
        "[collaboration-terminal-control] state notification failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new CollaborationTerminalControlError("closed");
  }
}

function requireControllerRole(role: CollaborationRole): void {
  if (role === "viewer") throw new CollaborationTerminalControlError("forbidden");
}

function sameHolder(lease: TerminalControlLease, identity: TerminalControlIdentity): boolean {
  return lease.actorId === identity.actorId && lease.connectionId === identity.connectionId;
}

function publicLease(lease: TerminalControlLease): TerminalControlLease {
  return {
    actorId: lease.actorId,
    connectionId: lease.connectionId,
    epoch: lease.epoch,
    expiresAt: lease.expiresAt,
  };
}

function keyFor(scopeId: string, terminalId: string, incarnation: string): string {
  return `${scopeId}\0${terminalId}\0${incarnation}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Invalid terminal control ${label}`);
  }
  return value;
}
