const DEFAULT_MAX_TERMINALS = 4_096;
const DEFAULT_MAX_VIEWERS_PER_TERMINAL = 64;
const DEFAULT_STALE_AFTER_MS = 90_000;

export type TerminalLiveRole = "writer" | "observer";

interface Viewer {
  forcedObserver: boolean;
  lastTouched: number;
  leaseEpoch: number | null;
  onRevoked(epoch: number | null): void;
}

interface TerminalOwnershipEntry {
  coordinated: boolean;
  epoch: number;
  holderId: string | null;
  viewers: Map<string, Viewer>;
}

export interface TerminalLiveOwnershipOptions {
  maxTerminals?: number;
  maxViewersPerTerminal?: number;
  staleAfterMs?: number;
  now?: () => number;
}

export interface TerminalLiveOwnership {
  attach(input: {
    key: string;
    viewerId: string;
    exclusive: boolean;
    observe?: boolean;
    onRevoked(epoch: number | null): void;
  }): TerminalLiveRole;
  claim(key: string, viewerId: string): number;
  detach(key: string, viewerId: string): void;
  touch(key: string, viewerId: string): void;
  role(key: string, viewerId: string): TerminalLiveRole;
  leaseEpoch(key: string, viewerId: string): number | null;
  allowsMutation(key: string, viewerId: string): boolean;
  close(): void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid terminal ownership limit");
  return value;
}

export function createTerminalLiveOwnership(
  options: TerminalLiveOwnershipOptions = {},
): TerminalLiveOwnership {
  const maxTerminals = positiveInteger(options.maxTerminals, DEFAULT_MAX_TERMINALS);
  const maxViewersPerTerminal = positiveInteger(
    options.maxViewersPerTerminal,
    DEFAULT_MAX_VIEWERS_PER_TERMINAL,
  );
  const staleAfterMs = positiveInteger(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const now = options.now ?? Date.now;
  const terminals = new Map<string, TerminalOwnershipEntry>();
  let closed = false;

  const revoke = (viewer: Viewer) => {
    try {
      viewer.onRevoked(viewer.leaseEpoch);
    } catch (error: unknown) {
      console.warn(
        "[terminal-ownership] revocation notification failed",
        error instanceof Error ? error.name : "unknown_error",
      );
    }
    viewer.leaseEpoch = null;
  };

  const sweep = () => {
    const cutoff = now() - staleAfterMs;
    for (const [key, entry] of terminals) {
      for (const [viewerId, viewer] of entry.viewers) {
        if (viewer.lastTouched >= cutoff) continue;
        if (entry.holderId === viewerId) entry.holderId = null;
        entry.viewers.delete(viewerId);
      }
      if (entry.viewers.size === 0) terminals.delete(key);
    }
  };

  const entryForAttach = (key: string): TerminalOwnershipEntry => {
    sweep();
    const existing = terminals.get(key);
    if (existing) return existing;
    if (closed || terminals.size >= maxTerminals) throw new Error("Terminal ownership registry busy");
    const created: TerminalOwnershipEntry = {
      coordinated: false,
      epoch: 0,
      holderId: null,
      viewers: new Map(),
    };
    terminals.set(key, created);
    return created;
  };

  const claim = (key: string, viewerId: string): number => {
    sweep();
    const entry = terminals.get(key);
    const claimant = entry?.viewers.get(viewerId);
    if (!entry || !claimant || closed) throw new Error("Terminal ownership viewer unavailable");
    const wasCoordinated = entry.coordinated;
    const previousHolderId = entry.holderId;
    entry.coordinated = true;
    for (const [candidateId, candidate] of entry.viewers) {
      if (candidateId !== viewerId
        && !candidate.forcedObserver
        && (!wasCoordinated || previousHolderId === candidateId)) {
        candidate.forcedObserver = true;
        revoke(candidate);
      }
    }
    entry.epoch += 1;
    entry.holderId = viewerId;
    claimant.forcedObserver = false;
    claimant.leaseEpoch = entry.epoch;
    claimant.lastTouched = now();
    return entry.epoch;
  };

  const role = (key: string, viewerId: string): TerminalLiveRole => {
    sweep();
    const entry = terminals.get(key);
    const viewer = entry?.viewers.get(viewerId);
    if (!entry || !viewer || viewer.forcedObserver) return "observer";
    return !entry.coordinated || entry.holderId === viewerId ? "writer" : "observer";
  };

  return {
    attach(input) {
      const entry = entryForAttach(input.key);
      if (!entry.viewers.has(input.viewerId) && entry.viewers.size >= maxViewersPerTerminal) {
        throw new Error("Terminal ownership registry busy");
      }
      entry.viewers.set(input.viewerId, {
        forcedObserver: input.observe === true,
        lastTouched: now(),
        leaseEpoch: null,
        onRevoked: input.onRevoked,
      });
      if (input.exclusive) claim(input.key, input.viewerId);
      return role(input.key, input.viewerId);
    },
    claim,
    detach(key, viewerId) {
      const entry = terminals.get(key);
      if (!entry) return;
      entry.viewers.delete(viewerId);
      if (entry.holderId === viewerId) entry.holderId = null;
      if (entry.viewers.size === 0) terminals.delete(key);
    },
    touch(key, viewerId) {
      sweep();
      const viewer = terminals.get(key)?.viewers.get(viewerId);
      if (viewer) viewer.lastTouched = now();
    },
    role,
    leaseEpoch(key, viewerId) {
      sweep();
      return terminals.get(key)?.viewers.get(viewerId)?.leaseEpoch ?? null;
    },
    allowsMutation(key, viewerId) {
      return role(key, viewerId) === "writer";
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of terminals.values()) {
        for (const viewer of entry.viewers.values()) revoke(viewer);
      }
      terminals.clear();
    },
  };
}
