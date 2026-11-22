import type { MessagingBridgeNetwork } from "@matrix-os/contracts/messaging-bridge";
import type { PendingNativeStep } from "./step-normalizer.js";

/**
 * In-memory, bounded state for login flows: which owner started each bridge
 * login process (a process id alone is never trusted) and the per-owner start
 * rate limit. Both are capped, expire by TTL, are swept periodically and are
 * cleared on shutdown. Losing them on restart only forces a new login attempt.
 */
export const LOGIN_PROCESS_TTL_MS = 10 * 60_000;
export const LOGIN_PROCESS_CAP_PER_OWNER = 16;
export const LOGIN_PROCESS_CAP_TOTAL = 2_048;
export const LOGIN_START_LIMIT = 5;
export const LOGIN_START_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_OWNER_CAP = 4_096;
const SWEEP_INTERVAL_MS = 60_000;

export interface LoginProcessRecord {
  ownerId: string;
  network: MessagingBridgeNetwork;
  /** The owner's homeserver user the bridge process acts for. */
  userId: string;
  pending: PendingNativeStep;
  touchedAt: number;
}

/**
 * `onAbandon` fires when a pending process expires or is evicted (never on an
 * explicit `delete`), so the caller can cancel it at the bridge best-effort.
 */
export function createLoginProcessRegistry(now: () => number, onAbandon: (processId: string, record: LoginProcessRecord) => void) {
  const processes = new Map<string, LoginProcessRecord>();

  function abandon(processId: string) {
    const record = processes.get(processId);
    if (!record) return;
    processes.delete(processId);
    onAbandon(processId, record);
  }

  function expired(record: LoginProcessRecord, at: number) {
    return at - record.touchedAt > LOGIN_PROCESS_TTL_MS;
  }

  function sweep() {
    const at = now();
    for (const [id, record] of [...processes]) if (expired(record, at)) abandon(id);
  }

  function oldest(predicate: (record: LoginProcessRecord) => boolean): string | undefined {
    for (const [id, record] of processes) if (predicate(record)) return id; // Map keeps insertion (touch) order.
    return undefined;
  }

  return {
    /** Record or refresh a pending process; evicts the owner's (then anyone's) oldest when over a cap. */
    put(processId: string, record: Omit<LoginProcessRecord, "touchedAt">) {
      processes.delete(processId);
      const owned = [...processes.values()].filter(entry => entry.ownerId === record.ownerId).length;
      if (owned >= LOGIN_PROCESS_CAP_PER_OWNER) {
        const victim = oldest(entry => entry.ownerId === record.ownerId);
        if (victim) abandon(victim);
      }
      if (processes.size >= LOGIN_PROCESS_CAP_TOTAL) sweep();
      if (processes.size >= LOGIN_PROCESS_CAP_TOTAL) {
        const victim = oldest(() => true);
        if (victim) abandon(victim);
      }
      processes.set(processId, { ...record, touchedAt: now() });
    },

    /** The process only if it is live and was started by this owner on this network. */
    get(processId: string, ownerId: string, network: MessagingBridgeNetwork): LoginProcessRecord | undefined {
      const record = processes.get(processId);
      if (!record) return undefined;
      if (expired(record, now())) {
        abandon(processId);
        return undefined;
      }
      return record.ownerId === ownerId && record.network === network ? record : undefined;
    },

    delete(processId: string) {
      processes.delete(processId);
    },

    sweep,
    /** Shutdown: forget everything without cancelling; the bridge expires its own processes. */
    clear() {
      processes.clear();
    },
    get size() {
      return processes.size;
    },
  };
}

export function createLoginStartLimiter(now: () => number) {
  const starts = new Map<string, number[]>();

  function prune(at: number) {
    for (const [owner, times] of starts) {
      const live = times.filter(time => at - time < LOGIN_START_WINDOW_MS);
      if (live.length === 0) starts.delete(owner);
      else starts.set(owner, live);
    }
  }

  return {
    /** Counts the attempt and returns false when the owner is over the limit. */
    tryAcquire(ownerId: string): boolean {
      const at = now();
      const live = (starts.get(ownerId) ?? []).filter(time => at - time < LOGIN_START_WINDOW_MS);
      if (live.length >= LOGIN_START_LIMIT) {
        starts.set(ownerId, live);
        return false;
      }
      starts.delete(ownerId);
      if (starts.size >= RATE_LIMIT_OWNER_CAP) prune(at);
      if (starts.size >= RATE_LIMIT_OWNER_CAP) {
        const first = starts.keys().next().value;
        if (first !== undefined) starts.delete(first);
      }
      starts.set(ownerId, [...live, at]);
      return true;
    },
    sweep() {
      prune(now());
    },
    clear() {
      starts.clear();
    },
  };
}

/** One unref'd timer sweeping both stores; returns the stop function used on shutdown. */
export function startLimitSweeper(stores: Array<{ sweep(): void }>): () => void {
  const timer = setInterval(() => {
    for (const store of stores) store.sweep();
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
