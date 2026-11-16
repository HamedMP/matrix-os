import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { CONTAINER_QUIESCE_TIMEOUT_MS, type ContainerLifecycleService } from './container-lifecycle-service.js';
import type { ContainerRuntimeClient, RuntimeTarget } from './container-runtime-client.js';

/**
 * Idle stop for container runtimes (spec 2691, "Idle authority"). The
 * platform decides idleness from owner traffic it observes while proxying,
 * plus unsettled funded runs; container reports never extend a session, and
 * a hard maximum session applies regardless. A stop is quiesce, then the
 * final flush, then suspend, each guarded by the row's generation.
 */

export interface IdleReaperConfig {
  idleMs: number;
  maxSessionMs: number;
  sweepIntervalMs: number;
  /** How long a quiesced runtime may wait for its runs before the flush proceeds (the run deadline). */
  quiesceDeadlineMs: number;
  pollIntervalMs: number;
  flushAttempts: number;
  flushBackoffMs: number;
  maxConcurrentStops: number;
  maxCandidatesPerSweep: number;
}

export const DEFAULT_IDLE_REAPER_CONFIG: IdleReaperConfig = {
  idleMs: 10 * 60_000,
  maxSessionMs: 4 * 60 * 60_000,
  sweepIntervalMs: 60_000,
  quiesceDeadlineMs: 15 * 60_000,
  pollIntervalMs: 5_000,
  flushAttempts: 3,
  flushBackoffMs: 5_000,
  maxConcurrentStops: 8,
  maxCandidatesPerSweep: 50,
};

const DEFAULT_TRACKER_MAX_ENTRIES = 10_000;
const DEFAULT_TRACKER_TTL_MS = 15 * 60_000;
const RESUME_TIMEOUT_MS = 10_000;
const ACTIVE_RESERVATION_STATUSES = ['reserved', 'starting', 'in_flight', 'settling'] as const;

/** Paths the shell calls on its own in the background; they say nothing about the owner using Matrix. */
const BACKGROUND_PATH = /(^|\/)(presence|heartbeat|ping|keepalive|client-errors)(\/|$)|^\/(relay|ingest)(\/|$)/;

export interface OwnerRequestLike {
  method: string;
  path: string;
  header(name: string): string | undefined;
}

/**
 * Meaningful activity (FR-009) seen at the proxy: work the owner submits, or
 * opening the runtime or an app. Polling, presence pings, and WebSocket
 * upgrades are not. WebSocket frames are not counted because the container
 * profile has no terminal.
 */
export function isMeaningfulOwnerRequest(request: OwnerRequestLike): boolean {
  if (request.header('upgrade')?.toLowerCase() === 'websocket') return false;
  if (BACKGROUND_PATH.test(request.path)) return false;
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return false;
  if (method === 'GET' || method === 'HEAD') {
    const mode = request.header('sec-fetch-mode')?.toLowerCase();
    const dest = request.header('sec-fetch-dest')?.toLowerCase();
    return mode === 'navigate' || dest === 'document' || dest === 'iframe';
  }
  return true;
}

export interface ActivityTracker {
  observe(machineId: string): void;
  lastObserved(machineId: string): Date | null;
  /** Writes pending observations in one statement; never moves a recorded time backwards. */
  flush(): Promise<void>;
  /**
   * Flushes on its own timer. Every replica that proxies owner traffic runs
   * this, since only background-worker replicas run the idle sweep.
   */
  startPeriodicFlush(intervalMs?: number): void;
  stopPeriodicFlush(): void;
  readonly size: number;
}

export const ACTIVITY_FLUSH_INTERVAL_MS = 30_000;

export function createActivityTracker(deps: {
  db: PlatformDB;
  now?: () => Date;
  maxEntries?: number;
  ttlMs?: number;
  logError?: (message: string, detail: Record<string, string | number>) => void;
}): ActivityTracker {
  const now = deps.now ?? (() => new Date());
  const maxEntries = deps.maxEntries ?? DEFAULT_TRACKER_MAX_ENTRIES;
  const ttlMs = deps.ttlMs ?? DEFAULT_TRACKER_TTL_MS;
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  /** Pending observations keyed by machine; Map order is recency order. */
  const pending = new Map<string, Date>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function evictExpired(at: number): void {
    for (const [machineId, seen] of pending) {
      if (at - seen.getTime() <= ttlMs) break;
      pending.delete(machineId);
    }
  }

  return {
    observe(machineId) {
      const at = now();
      evictExpired(at.getTime());
      pending.delete(machineId);
      while (pending.size >= maxEntries) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      pending.set(machineId, at);
    },
    lastObserved(machineId) {
      const seen = pending.get(machineId);
      if (!seen || now().getTime() - seen.getTime() > ttlMs) return null;
      return seen;
    },
    async flush() {
      if (pending.size === 0) return;
      const batch = [...pending.entries()];
      const ids = batch.map(([machineId]) => machineId);
      const times = batch.map(([, seen]) => seen.toISOString());
      try {
        await sql`
          UPDATE user_machines AS m
          SET last_activity_at = GREATEST(COALESCE(m.last_activity_at, v.seen), v.seen)
          FROM (SELECT unnest(${ids}::text[]) AS machine_id, unnest(${times}::timestamptz[]) AS seen) AS v
          WHERE m.machine_id = v.machine_id AND m.substrate = 'container' AND m.deleted_at IS NULL
        `.execute(deps.db.executor);
      } catch (error: unknown) {
        logError('[idle-reaper] activity flush failed', { cause: error instanceof Error ? error.name : 'unknown', pending: pending.size });
        return;
      }
      for (const [machineId, seen] of batch) {
        if (pending.get(machineId) === seen) pending.delete(machineId);
      }
    },
    startPeriodicFlush(intervalMs = ACTIVITY_FLUSH_INTERVAL_MS) {
      if (flushTimer) return;
      flushTimer = setInterval(() => { void this.flush(); }, intervalMs);
      flushTimer.unref?.();
    },
    stopPeriodicFlush() {
      if (flushTimer) clearInterval(flushTimer);
      flushTimer = null;
    },
    get size() {
      return pending.size;
    },
  };
}

type StopReason = 'idle' | 'max_session';

interface Candidate {
  machine_id: string;
  clerk_user_id: string;
  handle: string;
  generation: number;
  substrate_ref: string;
  private_address: string;
  reason: StopReason;
  /** When the sweep chose this runtime; owner activity after it cancels an idle stop. */
  selected_at: Date;
}

export interface IdleReaperDeps {
  db: PlatformDB;
  lifecycle: Pick<ContainerLifecycleService, 'beginQuiesce' | 'cancelQuiesce' | 'finishStop' | 'recoverAfterFailedStop' | 'recordFlush'>;
  runtime: ContainerRuntimeClient;
  activity: ActivityTracker;
  config?: Partial<IdleReaperConfig>;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logError?: (message: string, detail: Record<string, string | number>) => void;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createIdleReaper(deps: IdleReaperDeps) {
  const { db, lifecycle, runtime, activity } = deps;
  const config: IdleReaperConfig = { ...DEFAULT_IDLE_REAPER_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? abortableSleep;
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  const shutdownController = new AbortController();
  /** In-flight stops keyed by machine; bounded by `maxConcurrentStops`. */
  const stops = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping: Promise<void> | null = null;

  async function candidates(limit: number): Promise<Candidate[]> {
    const at = now();
    const idleBefore = new Date(at.getTime() - config.idleMs);
    const sessionBefore = new Date(at.getTime() - config.maxSessionMs);
    const rows = await db.executor.selectFrom('user_machines as m')
      .select(['m.machine_id', 'm.clerk_user_id', 'm.handle', 'm.generation', 'm.substrate_ref', 'm.private_address', 'm.started_at'])
      .where('m.substrate', '=', 'container')
      .where('m.deleted_at', 'is', null)
      .where('m.status', '=', 'running')
      .where('m.substrate_ref', 'is not', null)
      .where('m.private_address', 'is not', null)
      .where(eb => eb.or([
        eb('m.started_at', '<=', sessionBefore),
        eb.and([
          eb(eb.fn.coalesce('m.last_activity_at', 'm.started_at', 'm.status_changed_at'), '<=', idleBefore),
          eb.not(eb.exists(eb.selectFrom('ai_funded_usage_reservations as r')
            .select('r.reservation_id')
            .whereRef('r.machine_id', '=', 'm.machine_id')
            .where('r.status', 'in', ACTIVE_RESERVATION_STATUSES)
            .where('r.expires_at', '>', at.toISOString()))),
          // A run ending is activity too (FR-009): the idle window restarts when it settles or is released.
          eb.not(eb.exists(eb.selectFrom('ai_funded_usage_reservations as r')
            .select('r.reservation_id')
            .whereRef('r.machine_id', '=', 'm.machine_id')
            .where(sql<Date>`GREATEST(r.settled_at::timestamptz, r.released_at::timestamptz)`, '>', idleBefore))),
        ]),
      ]))
      .orderBy('m.last_activity_at', 'asc')
      .limit(limit)
      .execute();
    return rows.flatMap(row => row.substrate_ref && row.private_address ? [{
      machine_id: row.machine_id,
      clerk_user_id: row.clerk_user_id,
      handle: row.handle,
      generation: row.generation,
      substrate_ref: row.substrate_ref,
      private_address: row.private_address,
      reason: row.started_at && row.started_at.getTime() <= sessionBefore.getTime() ? 'max_session' as const : 'idle' as const,
      selected_at: at,
    }] : []);
  }

  /**
   * Stops left quiescing past the whole stop budget: the instance driving
   * them is gone. Their unit is suspended and the row moves to recovery, so
   * compute stops and the next owner request recovers the home.
   */
  async function recoverAbandonedStops(limit: number): Promise<void> {
    const abandonedBefore = new Date(now().getTime() - CONTAINER_QUIESCE_TIMEOUT_MS);
    const rows = await db.executor.selectFrom('user_machines')
      .select(['machine_id', 'generation'])
      .where('substrate', '=', 'container')
      .where('deleted_at', 'is', null)
      .where('status', '=', 'quiescing')
      .where('status_changed_at', '<=', abandonedBefore)
      .orderBy('status_changed_at', 'asc')
      .limit(limit)
      .execute();
    for (const row of rows) {
      if (stops.has(row.machine_id) || shutdownController.signal.aborted) continue;
      try {
        await lifecycle.recoverAfterFailedStop(row.machine_id, row.generation, 'quiesce_timeout', shutdownController.signal);
      } catch (error: unknown) {
        if (shutdownController.signal.aborted) return;
        logError('[idle-reaper] abandoned stop recovery failed', { cause: error instanceof Error ? error.name : 'unknown' });
      }
    }
  }

  /** Owner traffic after the quiesce began, from this instance or another one's persisted record. */
  async function ownerReturned(machineId: string, since: Date): Promise<boolean> {
    const local = activity.lastObserved(machineId);
    if (local && local.getTime() > since.getTime()) return true;
    const row = await db.executor.selectFrom('user_machines')
      .select('last_activity_at').where('machine_id', '=', machineId).executeTakeFirst();
    return Boolean(row?.last_activity_at && row.last_activity_at.getTime() > since.getTime());
  }

  async function resumeQuietly(target: RuntimeTarget): Promise<boolean> {
    try {
      return await runtime.resume(target, AbortSignal.timeout(RESUME_TIMEOUT_MS));
    } catch (error: unknown) {
      logError('[idle-reaper] resume failed', { cause: error instanceof Error ? error.name : 'unknown' });
      return false;
    }
  }

  /** Quiesce until runs settle or reach the deadline, unless the owner comes back during an idle stop. */
  async function quiesce(candidate: Candidate, target: RuntimeTarget, signal: AbortSignal): Promise<'flush' | 'cancelled' | 'unreachable'> {
    const deadline = now().getTime() + config.quiesceDeadlineMs;
    let quiesced = false;
    /** Owner activity since the runtime was selected cancels an idle stop. */
    const cancelledByOwner = async (): Promise<'flush' | 'cancelled' | null> => {
      if (candidate.reason !== 'idle' || !await ownerReturned(candidate.machine_id, candidate.selected_at)) return null;
      // A gateway that will not reopen keeps refusing runs, so the stop goes on and the owner wakes it after.
      if (quiesced && !await resumeQuietly(target)) return 'flush';
      await lifecycle.cancelQuiesce(candidate.machine_id, candidate.generation);
      return 'cancelled';
    };
    for (;;) {
      const result = await runtime.quiesce(target, signal);
      if (result.ok) quiesced = true;
      else logError('[idle-reaper] quiesce refused', { error: result.error });
      // The first reply is checked too: an owner who came back must not be flushed and suspended.
      const returned = await cancelledByOwner();
      if (returned) return returned;
      if (result.ok && result.unsettledRuns === 0) return 'flush';
      if (now().getTime() >= deadline) return quiesced ? 'flush' : 'unreachable';
      await sleep(config.pollIntervalMs, signal);
      const returnedWhileWaiting = await cancelledByOwner();
      if (returnedWhileWaiting) return returnedWhileWaiting;
    }
  }

  async function flush(candidate: Candidate, target: RuntimeTarget, signal: AbortSignal): Promise<boolean> {
    for (let attempt = 1; attempt <= config.flushAttempts; attempt += 1) {
      const result = await runtime.flush(target, signal);
      if (result.ok) {
        await lifecycle.recordFlush(candidate.machine_id, candidate.generation, result.manifestDigest);
        return true;
      }
      logError('[idle-reaper] final flush failed', { error: result.error, attempt });
      if (attempt < config.flushAttempts) await sleep(config.flushBackoffMs, signal);
    }
    return false;
  }

  async function stopRuntime(candidate: Candidate, signal: AbortSignal): Promise<void> {
    const { machine_id: machineId, generation } = candidate;
    if (!await lifecycle.beginQuiesce(machineId, generation)) return;
    const target: RuntimeTarget = {
      machineId, handle: candidate.handle, clerkUserId: candidate.clerk_user_id,
      unitId: candidate.substrate_ref, endpointHost: candidate.private_address,
    };
    try {
      const quiesced = await quiesce(candidate, target, signal);
      if (quiesced === 'cancelled') return;
      if (quiesced === 'unreachable') {
        await lifecycle.recoverAfterFailedStop(machineId, generation, 'quiesce_timeout', signal);
        return;
      }
      if (!await flush(candidate, target, signal)) {
        // Reopen the gateway first so a recovery start can reuse this unit and its unflushed disk.
        await resumeQuietly(target);
        await lifecycle.recoverAfterFailedStop(machineId, generation, 'flush_failed', signal);
        return;
      }
      await lifecycle.finishStop(machineId, generation, signal);
    } catch (error: unknown) {
      if (!signal.aborted) throw error;
      // Shutdown: the compute is still alive, so the runtime keeps serving and a later sweep retries,
      // but only once its gateway has reopened; otherwise it stays recoverable rather than "running".
      if (await resumeQuietly(target)) await lifecycle.cancelQuiesce(machineId, generation);
      else await lifecycle.recoverAfterFailedStop(machineId, generation, 'quiesce_timeout', signal);
    }
  }

  function track(candidate: Candidate): void {
    const work = stopRuntime(candidate, shutdownController.signal)
      .catch((error: unknown) => {
        logError('[idle-reaper] stop failed', { cause: error instanceof Error ? error.name : 'unknown' });
      })
      .finally(() => { stops.delete(candidate.machine_id); });
    stops.set(candidate.machine_id, work);
  }

  async function runSweep(): Promise<void> {
    await activity.flush();
    await recoverAbandonedStops(config.maxCandidatesPerSweep);
    const room = config.maxConcurrentStops - stops.size;
    if (room <= 0 || shutdownController.signal.aborted) return;
    for (const candidate of await candidates(Math.min(room, config.maxCandidatesPerSweep))) {
      if (stops.size >= config.maxConcurrentStops || shutdownController.signal.aborted) break;
      if (!stops.has(candidate.machine_id)) track(candidate);
    }
  }

  return {
    /** One sweep at a time per instance; overlapping calls share it. */
    sweep(): Promise<void> {
      sweeping ??= runSweep()
        .catch((error: unknown) => {
          logError('[idle-reaper] sweep failed', { cause: error instanceof Error ? error.name : 'unknown' });
        })
        .finally(() => { sweeping = null; });
      return sweeping;
    },
    start(): void {
      if (timer || shutdownController.signal.aborted) return;
      timer = setInterval(() => { void this.sweep(); }, config.sweepIntervalMs);
      timer.unref?.();
    },
    /** Resolves when every stop this instance started has settled. */
    async drain(): Promise<void> {
      while (stops.size > 0) await Promise.allSettled([...stops.values()]);
    },
    async shutdown(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      shutdownController.abort();
      await sweeping;
      while (stops.size > 0) await Promise.allSettled([...stops.values()]);
      await activity.flush();
    },
  };
}

export type IdleReaper = ReturnType<typeof createIdleReaper>;
