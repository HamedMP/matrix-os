import { clampTerminalSize, type TerminalSize } from "./sizing.js";

export interface TerminalLease {
  holderId: string;
  epoch: number;
  size: TerminalSize;
}

export interface LeaseGrant extends TerminalLease {
  /** Present only when a still-live renderer was displaced. */
  revoked?: Pick<TerminalLease, "holderId" | "epoch">;
}

export interface TerminalLeaseCoordinatorOptions {
  now?: () => number;
  ttlMs?: number;
  maxLeases?: number;
}

interface LiveLease extends TerminalLease {
  lastTouchedAt: number;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_LEASES = 256;

/**
 * Authority-owned, ephemeral live-renderer leases. A terminal's Zellij
 * runtime outlives a lease; on a gateway restart all leases simply vanish and
 * the next focused renderer establishes a fresh bridge.
 */
export function createTerminalLeaseCoordinator(options: TerminalLeaseCoordinatorOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_LEASE_TTL_MS));
  const maxLeases = Math.max(1, Math.floor(options.maxLeases ?? DEFAULT_MAX_LEASES));
  const leases = new Map<string, LiveLease>();
  let nextEpoch = 0;

  function expired(lease: LiveLease, at: number): boolean {
    return at - lease.lastTouchedAt > ttlMs;
  }

  function removeExpired(at: number): void {
    for (const [terminalId, lease] of leases) {
      if (expired(lease, at)) leases.delete(terminalId);
    }
  }

  function current(terminalId: string): TerminalLease | null {
    const lease = leases.get(terminalId);
    if (!lease) return null;
    if (expired(lease, now())) {
      leases.delete(terminalId);
      return null;
    }
    return { holderId: lease.holderId, epoch: lease.epoch, size: lease.size };
  }

  function acquire(terminalId: string, holderId: string, size: TerminalSize): LeaseGrant {
    const at = now();
    removeExpired(at);
    const prior = leases.get(terminalId);
    if (!prior && leases.size >= maxLeases) {
      throw new Error("terminal_lease_capacity");
    }
    const lease: LiveLease = {
      holderId,
      epoch: ++nextEpoch,
      size: clampTerminalSize(size),
      lastTouchedAt: at,
    };
    leases.set(terminalId, lease);
    return prior
      ? { holderId, epoch: lease.epoch, size: lease.size, revoked: { holderId: prior.holderId, epoch: prior.epoch } }
      : { holderId, epoch: lease.epoch, size: lease.size };
  }

  function holds(terminalId: string, holderId: string, epoch: number): boolean {
    const lease = current(terminalId);
    return lease !== null && lease.holderId === holderId && lease.epoch === epoch;
  }

  function touch(terminalId: string, holderId: string, epoch: number): boolean {
    const lease = leases.get(terminalId);
    if (!lease || lease.holderId !== holderId || lease.epoch !== epoch) {
      return false;
    }
    lease.lastTouchedAt = now();
    return true;
  }

  function resize(terminalId: string, holderId: string, epoch: number, size: TerminalSize): TerminalLease | null {
    if (!touch(terminalId, holderId, epoch)) return null;
    const lease = leases.get(terminalId);
    if (!lease) return null;
    lease.size = clampTerminalSize(size);
    return { holderId: lease.holderId, epoch: lease.epoch, size: lease.size };
  }

  function release(terminalId: string, holderId: string, epoch: number): boolean {
    if (!holds(terminalId, holderId, epoch)) return false;
    leases.delete(terminalId);
    return true;
  }

  function dispose(): void {
    leases.clear();
  }

  return { acquire, current, dispose, holds, release, resize, touch };
}
