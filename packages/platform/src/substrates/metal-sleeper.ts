import { sql, type ExpressionBuilder } from 'kysely';
import { RuntimeLifecycleStatusSchema, type RuntimeLifecycleStatus } from '@matrix-os/contracts/runtime-lifecycle';
import { mapUserMachine } from '../database/user-machine-records.js';
import type { PlatformDatabase, PlatformDB, UserMachineRecord } from '../db.js';
import { buildPlatformVerificationToken } from '../platform-token.js';
import type { SubstrateRegistry } from './registry.js';
import { wakeOnDemandRuntime } from './substrate-wake.js';
import type { OnDemandRuntimeSubstrate, RuntimeRef } from './types.js';
import { applyUpstreamCredentials, needsVerifiedTransport, verifiedDispatcher } from './upstream-transport.js';

/**
 * Idle sleep and scheduled wake for free metal runtimes (spec 2691, ENG-520
 * Task P6). Every tick first wakes sleeping free runtimes whose scheduled wake
 * is due, then puts idle free runtimes to sleep:
 *
 * - A candidate is a running free metal runtime with no owner activity for
 *   60 minutes (or none ever, and awake for 60 minutes).
 * - The runtime's own lifecycle answer decides. It never sleeps while busy, on
 *   an `unknown` busy source, or on an incomplete schedule. The 6 h idle guard
 *   overrides only known busy reasons: awake 6 h with no owner activity for
 *   6 h suspends it and stamps `idle_guard_at`.
 * - `next_wake_at` (60 s before the next scheduled job) is recorded before the
 *   suspend; a wake time already past means the runtime stays awake.
 * - Any lifecycle failure (timeout, non-2xx, schema failure) skips the runtime
 *   for this tick. Paid runtimes are never touched.
 *
 * Every state change is a compare-and-set on (status, generation), so a
 * runtime replaced, deleted, or woken concurrently is never overwritten.
 */

export const METAL_SLEEP_INTERVAL_MS = 60_000;
export const IDLE_SLEEP_AFTER_MS = 60 * 60_000;
export const IDLE_GUARD_AFTER_MS = 6 * 60 * 60_000;
export const SCHEDULED_WAKE_LEAD_MS = 60_000;
/**
 * A just-woken runtime gets this long to start the job it was woken for
 * before it may sleep again (its next scheduled time may already be past).
 */
export const WAKE_SETTLE_MS = 5 * 60_000;
export const LIFECYCLE_TIMEOUT_MS = 10_000;
export const LIFECYCLE_RESPONSE_LIMIT_BYTES = 4 * 1024;
export const LIFECYCLE_ALERT_AFTER_MS = 6 * 60 * 60_000;
export const LIFECYCLE_ALERT_REPEAT_MS = 60 * 60_000;
export const SLEEP_CANDIDATES_PER_TICK = 50;
export const WAKES_PER_TICK = 20;
const LIFECYCLE_ALERT_TRACK_MAX = 10_000;
const LIFECYCLE_PATH = '/api/system/lifecycle';
const ASLEEP_STATUS = 'suspended';
const HOUR_MS = 60 * 60_000;

type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => console.error(`[metal-sleeper] ${event}`, JSON.stringify(fields));

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export type LifecycleFailureCode = 'not_routable' | 'timeout' | 'unreachable' | 'unavailable' | 'invalid_response';

export type LifecycleRead =
  | { ok: true; status: RuntimeLifecycleStatus }
  | { ok: false; code: LifecycleFailureCode };

export interface MetalSleeperDeps {
  db: PlatformDB;
  substrate: OnDemandRuntimeSubstrate;
  /** Reads the runtime's lifecycle answer. Throws only when `signal` aborts. */
  readLifecycle(machine: UserMachineRecord, signal: AbortSignal): Promise<LifecycleRead>;
  log?: Log;
}

export interface MetalSleeper {
  /** One pass: scheduled wakes, then idle sleep. A call while a pass runs joins it. */
  tick(now: Date, signal?: AbortSignal): Promise<void>;
}

type Eb = ExpressionBuilder<PlatformDatabase & { m: PlatformDatabase['user_machines'] }, 'm'>;

/** Free runtimes only: the owner's stored entitlement is the free plan. Paid runtimes never sleep. */
function ownedByFreePlan(eb: Eb) {
  return eb.exists(
    eb.selectFrom('billing_entitlements as e')
      .select(sql<number>`1`.as('one'))
      .whereRef('e.clerk_user_id', '=', 'm.clerk_user_id')
      .where('e.source', '=', 'free'),
  );
}

function refFor(machine: UserMachineRecord): RuntimeRef {
  return { machineId: machine.machineId, handle: machine.handle, runtimeSlot: machine.runtimeSlot, generation: machine.generation };
}

function ms(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}

type Verdict =
  | { sleep: false; alert?: string }
  | { sleep: true; alert?: undefined; guard: boolean; nextWakeAt: Date | null };

export function createMetalSleeper(deps: MetalSleeperDeps): MetalSleeper {
  const { db, substrate } = deps;
  const log = deps.log ?? defaultLog;
  // Insertion-ordered LRU of runtimes whose lifecycle is unavailable or incomplete, capped.
  const unavailableSince = new Map<string, { since: number; warnedAt: number | null }>();
  let running: Promise<void> | undefined;

  function noteHealthy(machineId: string): void {
    unavailableSince.delete(machineId);
  }

  function noteUnavailable(machineId: string, code: string, now: number): void {
    const entry = unavailableSince.get(machineId) ?? { since: now, warnedAt: null };
    unavailableSince.delete(machineId);
    unavailableSince.set(machineId, entry);
    while (unavailableSince.size > LIFECYCLE_ALERT_TRACK_MAX) {
      const oldest = unavailableSince.keys().next().value;
      if (oldest === undefined) break;
      unavailableSince.delete(oldest);
    }
    const elapsed = now - entry.since;
    if (elapsed < LIFECYCLE_ALERT_AFTER_MS) return;
    if (entry.warnedAt !== null && now - entry.warnedAt < LIFECYCLE_ALERT_REPEAT_MS) return;
    entry.warnedAt = now;
    log('lifecycle_unavailable_alert', { machineId, code, hours: Math.floor(elapsed / HOUR_MS) });
  }

  function decide(machine: UserMachineRecord, status: RuntimeLifecycleStatus, now: number): Verdict {
    if (status.busyReasons.includes('unknown')) return { sleep: false, alert: 'busy_unknown' };
    if (!status.scheduleComplete) return { sleep: false, alert: 'schedule_incomplete' };
    let guard = false;
    if (status.busy) {
      const awakeSince = ms(machine.awakeSince);
      const lastActivity = ms(machine.lastActivityAt);
      guard = awakeSince !== null && now - awakeSince >= IDLE_GUARD_AFTER_MS
        && (lastActivity === null || now - lastActivity >= IDLE_GUARD_AFTER_MS);
      if (!guard) return { sleep: false };
    }
    const scheduledAt = ms(status.nextScheduledAt);
    if (scheduledAt === null) return { sleep: true, guard, nextWakeAt: null };
    const wakeAt = scheduledAt - SCHEDULED_WAKE_LEAD_MS;
    // A job due within the lead time keeps the runtime awake this tick.
    if (wakeAt <= now) return { sleep: false };
    return { sleep: true, guard, nextWakeAt: new Date(wakeAt) };
  }

  async function wakeDue(now: Date, signal: AbortSignal): Promise<void> {
    const rows = await db.executor.selectFrom('user_machines as m').selectAll('m')
      .where('m.substrate', '=', 'metal')
      .where('m.status', '=', ASLEEP_STATUS)
      .where('m.deleted_at', 'is', null)
      .where('m.next_wake_at', '<=', now)
      .where(ownedByFreePlan)
      .orderBy('m.next_wake_at').orderBy('m.machine_id')
      .limit(WAKES_PER_TICK)
      .execute();
    for (const row of rows) {
      if (signal.aborted) return;
      const machine = mapUserMachine(row);
      try {
        const { result } = await wakeOnDemandRuntime(db, substrate, machine, {
          now: () => now,
          signal,
          log: (message, detail) => log('scheduled_wake_error', { machineId: machine.machineId, message, ...detail }),
        });
        if (result.state === 'running') continue;
        if (result.state === 'failed' && result.code === 'needs_recovery') {
          // Retrying cannot help and would hold a wake slot every tick; an operator must recover it.
          await db.executor.updateTable('user_machines').set({ next_wake_at: null })
            .where('machine_id', '=', machine.machineId)
            .where('generation', '=', machine.generation)
            .where('status', '=', machine.status)
            .where('deleted_at', 'is', null)
            .execute();
          log('scheduled_wake_needs_recovery', { machineId: machine.machineId });
          continue;
        }
        // Left due: the next tick retries.
        log('scheduled_wake_failed', {
          machineId: machine.machineId, state: result.state, ...(result.state === 'failed' ? { code: result.code } : {}),
        });
      } catch (error: unknown) {
        if (signal.aborted) return;
        log('scheduled_wake_failed', { machineId: machine.machineId, state: 'error', code: errorCode(error) });
      }
    }
  }

  async function sleepOne(machine: UserMachineRecord, now: Date, signal: AbortSignal): Promise<void> {
    const nowMs = now.getTime();
    let read: LifecycleRead;
    try {
      read = await deps.readLifecycle(machine, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      log('lifecycle_read_failed', { machineId: machine.machineId, code: errorCode(error) });
      noteUnavailable(machine.machineId, 'read_failed', nowMs);
      return;
    }
    if (!read.ok) {
      noteUnavailable(machine.machineId, read.code, nowMs);
      return;
    }
    const verdict = decide(machine, read.status, nowMs);
    if (verdict.alert) noteUnavailable(machine.machineId, verdict.alert, nowMs);
    else noteHealthy(machine.machineId);
    if (!verdict.sleep) return;

    // Record the wake time first, and only while the runtime is still this
    // generation, still running, and still idle (owner activity may have
    // arrived during the lifecycle read).
    const idleBefore = new Date(nowMs - (verdict.guard ? IDLE_GUARD_AFTER_MS : IDLE_SLEEP_AFTER_MS));
    const claimed = await db.executor.updateTable('user_machines')
      .set({ next_wake_at: verdict.nextWakeAt })
      .where('machine_id', '=', machine.machineId)
      .where('generation', '=', machine.generation)
      .where('status', '=', 'running')
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([
        eb('last_activity_at', '<=', idleBefore),
        eb.and([eb('last_activity_at', 'is', null), eb('awake_since', '<=', idleBefore)]),
      ]))
      .returning('machine_id')
      .executeTakeFirst();
    if (!claimed) {
      log('sleep_skipped_changed', { machineId: machine.machineId });
      return;
    }

    // On any failure the runtime keeps running; the record stays running with no scheduled wake.
    const release = () => db.executor.updateTable('user_machines').set({ next_wake_at: null })
      .where('machine_id', '=', machine.machineId)
      .where('generation', '=', machine.generation)
      .where('status', '=', 'running')
      .where('deleted_at', 'is', null)
      .execute();
    let outcome: Awaited<ReturnType<OnDemandRuntimeSubstrate['stop']>>;
    try {
      outcome = await substrate.stop(refFor(machine), signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      log('sleep_suspend_failed', { machineId: machine.machineId, code: errorCode(error) });
      await release();
      return;
    }
    if (outcome.state === 'failed') {
      log('sleep_suspend_failed', { machineId: machine.machineId, code: outcome.code });
      await release();
      return;
    }

    const recorded = await db.executor.updateTable('user_machines')
      .set({ status: ASLEEP_STATUS, awake_since: null, ...(verdict.guard ? { idle_guard_at: now } : {}) })
      .where('machine_id', '=', machine.machineId)
      .where('generation', '=', machine.generation)
      .where('status', '=', 'running')
      .where('deleted_at', 'is', null)
      .returning('machine_id')
      .executeTakeFirst();
    if (!recorded) {
      // The host still sleeps the VM; the ingress reports it asleep and the next request wakes it.
      log('sleep_record_lost', { machineId: machine.machineId });
      return;
    }
    if (verdict.guard) log('idle_guard_suspended', { machineId: machine.machineId, busyReasons: read.status.busyReasons });
  }

  async function sleepIdle(now: Date, signal: AbortSignal): Promise<void> {
    const nowMs = now.getTime();
    // A running metal runtime with no awake stamp (provisioned or recovered before the sleeper ran) starts its clock now.
    await db.executor.updateTable('user_machines').set({ awake_since: now })
      .where('substrate', '=', 'metal')
      .where('status', '=', 'running')
      .where('awake_since', 'is', null)
      .where('deleted_at', 'is', null)
      .execute();
    const idleBefore = new Date(nowMs - IDLE_SLEEP_AFTER_MS);
    const settledBefore = new Date(nowMs - WAKE_SETTLE_MS);
    const rows = await db.executor.selectFrom('user_machines as m').selectAll('m')
      .where('m.substrate', '=', 'metal')
      .where('m.status', '=', 'running')
      .where('m.deleted_at', 'is', null)
      .where('m.awake_since', '<=', settledBefore)
      .where((eb) => eb.or([
        eb('m.last_activity_at', '<=', idleBefore),
        eb.and([eb('m.last_activity_at', 'is', null), eb('m.awake_since', '<=', idleBefore)]),
      ]))
      .where(ownedByFreePlan)
      .orderBy(sql`coalesce(m.last_activity_at, m.awake_since)`).orderBy('m.machine_id')
      .limit(SLEEP_CANDIDATES_PER_TICK)
      .execute();
    for (const row of rows) {
      if (signal.aborted) return;
      const machine = mapUserMachine(row);
      try {
        await sleepOne(machine, now, signal);
      } catch (error: unknown) {
        if (signal.aborted) return;
        log('sleep_machine_failed', { machineId: machine.machineId, code: errorCode(error) });
      }
    }
  }

  async function pass(now: Date, signal: AbortSignal): Promise<void> {
    await db.ready;
    await wakeDue(now, signal);
    if (!signal.aborted) await sleepIdle(now, signal);
  }

  return {
    tick(now, signal = new AbortController().signal) {
      if (running) return running;
      const current = pass(now, signal).finally(() => {
        if (running === current) running = undefined;
      });
      running = current;
      return current;
    },
  };
}

// ---------------------------------------------------------------------------
// Worker

export interface MetalSleeperWorker {
  /** Stops scheduling ticks and aborts the one in flight (synchronous; call first on shutdown). */
  stop(): void;
  /** Resolves when the tick in flight (if any) settles. */
  drain(): Promise<void>;
}

/** Ticks now and every `intervalMs`; a tick while one is still running is skipped. */
export function startMetalSleeperWorker(input: {
  sleeper: MetalSleeper;
  intervalMs?: number;
  now?: () => Date;
  log?: Log;
}): MetalSleeperWorker {
  const log = input.log ?? defaultLog;
  const now = input.now ?? (() => new Date());
  const controller = new AbortController();
  let inFlight: Promise<void> | undefined;

  const tick = (): void => {
    if (controller.signal.aborted || inFlight) return;
    const current = input.sleeper.tick(now(), controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) log('sleeper_tick_failed', { code: errorCode(error) });
      })
      .finally(() => {
        if (inFlight === current) inFlight = undefined;
      });
    inFlight = current;
  };

  tick();
  const interval = setInterval(tick, input.intervalMs ?? METAL_SLEEP_INTERVAL_MS);
  interval.unref?.();
  return {
    stop() {
      clearInterval(interval);
      controller.abort();
    },
    drain() {
      return inFlight ?? Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle reader

async function readBoundedText(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > LIFECYCLE_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Reads `GET /api/system/lifecycle` from the runtime's gateway through its
 * substrate upstream (for metal, the host ingress with its credential and
 * verified TLS), authenticated with the same platform runtime credential the
 * session-routing proxy uses. Failures are typed codes; nothing from the
 * response reaches a log.
 */
export function createLifecycleReader(input: {
  substrates: SubstrateRegistry;
  platformSecret: string;
  timeoutMs?: number;
}): MetalSleeperDeps['readLifecycle'] {
  const timeoutMs = input.timeoutMs ?? LIFECYCLE_TIMEOUT_MS;
  return async (machine, signal) => {
    const resolution = input.substrates.resolveUpstream(machine, { path: LIFECYCLE_PATH });
    if (resolution.kind !== 'upstream') return { ok: false, code: 'not_routable' };
    const { upstream } = resolution;
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, input.platformSecret)}`,
    });
    applyUpstreamCredentials(headers, upstream);
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(upstream.url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: combined,
        ...(needsVerifiedTransport(upstream) ? { dispatcher: verifiedDispatcher(upstream) } : {}),
      } as RequestInit);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return { ok: false, code: 'unavailable' };
      }
      const text = await readBoundedText(response.body);
      if (text === null) return { ok: false, code: 'invalid_response' };
      const parsed = RuntimeLifecycleStatusSchema.safeParse(parseJson(text));
      return parsed.success ? { ok: true, status: parsed.data } : { ok: false, code: 'invalid_response' };
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) return { ok: false, code: 'timeout' };
      if (error instanceof Error) return { ok: false, code: 'unreachable' };
      throw error;
    }
  };
}
