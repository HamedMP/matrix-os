import { sql, type ExpressionBuilder, type Selectable } from 'kysely';
import type { RuntimeLifecycleStatus } from '@matrix-os/contracts/runtime-lifecycle';
import { mapUserMachine } from '../database/user-machine-records.js';
import { getUserMachine } from '../database/user-machines.js';
import type { PlatformDatabase, PlatformDB, UserMachineRecord } from '../db.js';
import { resolveEffectiveBillingEntitlementForSlot } from '../billing-entitlement-resolver.js';
import { markRuntimeAsleep } from './runtime-asleep.js';
import { wakeOnDemandRuntime } from './substrate-wake.js';
import type { OnDemandRuntimeSubstrate, RuntimeRef } from './types.js';
import type { LifecycleRead } from './metal-lifecycle-reader.js';

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
 *   for this tick. Paid runtimes are never put to sleep; a wake saved while
 *   free is still honored after an upgrade.
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
export const LIFECYCLE_ALERT_AFTER_MS = 6 * 60 * 60_000;
export const LIFECYCLE_ALERT_REPEAT_MS = 60 * 60_000;
export const SLEEP_CANDIDATES_PER_TICK = 50;
export const WAKES_PER_TICK = 20;
/** Scheduled wakes run this many at a time, so one slow or unreachable VM cannot hold up the others. */
export const WAKE_CONCURRENCY = 5;
/** A checked candidate rotates behind the others until this long has passed, so runtimes skipped every tick cannot starve the scan. */
export const SLEEP_RECHECK_AFTER_MS = 5 * 60_000;
/** The sleep pass starts no new candidate after this long, so a slow pass cannot hold off the next scheduled wakes. */
export const SLEEP_PASS_BUDGET_MS = 45_000;
/** A failing scheduled wake is retried after 1 min, doubling up to this cap, so failures rotate behind fresh wakes. */
export const WAKE_RETRY_BASE_MS = 60_000;
export const WAKE_RETRY_MAX_MS = 15 * 60_000;
const LIFECYCLE_ALERT_TRACK_MAX = 10_000;
const ASLEEP_STATUS = 'suspended';
const HOUR_MS = 60 * 60_000;

type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => console.error(`[metal-sleeper] ${event}`, JSON.stringify(fields));

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export type { LifecycleFailureCode, LifecycleRead } from './metal-lifecycle-reader.js';

export interface MetalSleeperDeps {
  db: PlatformDB;
  substrate: OnDemandRuntimeSubstrate;
  /** Reads the runtime's lifecycle answer. Throws only when `signal` aborts. */
  readLifecycle(machine: UserMachineRecord, signal: AbortSignal): Promise<LifecycleRead>;
  log?: Log;
  /** Monotonic milliseconds for the sleep pass budget and for the current time within a pass. */
  elapsedMs?: () => number;
  /** Billing catalogs for the effective-plan check (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface MetalSleeper {
  /** One pass: scheduled wakes, then idle sleep. A call while a pass runs joins it. */
  tick(now: Date, signal?: AbortSignal): Promise<void>;
}

type Eb = ExpressionBuilder<PlatformDatabase & { m: PlatformDatabase['user_machines'] }, 'm'>;

/**
 * Free runtimes only: the primary slot of an owner whose stored entitlement is
 * the free plan and who holds no active operator override (an override wins
 * over the stored entitlement). Paid runtimes never sleep. A sleep candidate is
 * also checked against the resolved effective plan before it is suspended.
 */
function ownedByFreePlan(now: Date) {
  return (eb: Eb) => eb.and([
    eb('m.runtime_slot', '=', 'primary'),
    eb.exists(
      eb.selectFrom('billing_entitlements as e')
        .select(sql<number>`1`.as('one'))
        .whereRef('e.clerk_user_id', '=', 'm.clerk_user_id')
        .where('e.source', '=', 'free'),
    ),
    eb.not(eb.exists(
      eb.selectFrom('billing_entitlement_overrides as o')
        .select(sql<number>`1`.as('one'))
        .whereRef('o.clerk_user_id', '=', 'm.clerk_user_id')
        .where('o.revoked_at', 'is', null)
        .where((inner) => inner.or([inner('o.expires_at', 'is', null), inner('o.expires_at', '>', now.toISOString())])),
    )),
  ]);
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
  const elapsedMs = deps.elapsedMs ?? (() => performance.now());
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

  /** Moves a failed wake behind fresh ones: retry after 1, 2, 4 … minutes, at most 15. */
  async function backOff(machineId: string, generation: number, failures: number, now: Date): Promise<void> {
    const delay = Math.min(WAKE_RETRY_BASE_MS * 2 ** Math.min(failures, 16), WAKE_RETRY_MAX_MS);
    await db.executor.updateTable('user_machines')
      .set({ next_wake_at: new Date(now.getTime() + delay), wake_failures: failures + 1 })
      .where('machine_id', '=', machineId)
      .where('generation', '=', generation)
      .where('status', '=', ASLEEP_STATUS)
      .where('wake_failures', '=', failures)
      .where('deleted_at', 'is', null)
      .execute();
  }

  async function wakeDue(now: Date, signal: AbortSignal): Promise<void> {
    const rows = await db.executor.selectFrom('user_machines as m').selectAll('m')
      .where('m.substrate', '=', 'metal')
      .where('m.status', '=', ASLEEP_STATUS)
      .where('m.deleted_at', 'is', null)
      .where('m.next_wake_at', '<=', now)
      // No plan check: a wake saved while free is honored after an upgrade; plans gate only new sleep.
      .orderBy('m.next_wake_at').orderBy('m.machine_id')
      .limit(WAKES_PER_TICK)
      .execute();
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < rows.length && !signal.aborted) {
        const row = rows[next];
        next += 1;
        await wakeOne(row, now, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WAKE_CONCURRENCY, rows.length) }, lane));
  }

  async function wakeOne(row: Selectable<PlatformDatabase['user_machines']>, now: Date, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const machine = mapUserMachine(row);
    try {
      const { result } = await wakeOnDemandRuntime(db, substrate, machine, {
        now: () => now,
        signal,
        log: (message, detail) => log('scheduled_wake_error', { machineId: machine.machineId, message, ...detail }),
      });
      if (result.state === 'running') return;
      if (result.state === 'failed' && result.code === 'needs_recovery') {
        // Retrying cannot help and would hold a wake slot every tick; an operator must recover it.
        await db.executor.updateTable('user_machines').set({ next_wake_at: null })
          .where('machine_id', '=', machine.machineId)
          .where('generation', '=', machine.generation)
          .where('status', '=', machine.status)
          .where('deleted_at', 'is', null)
          .execute();
        log('scheduled_wake_needs_recovery', { machineId: machine.machineId });
        return;
      }
      log('scheduled_wake_failed', {
        machineId: machine.machineId, state: result.state, ...(result.state === 'failed' ? { code: result.code } : {}),
      });
      await backOff(row.machine_id, row.generation, row.wake_failures, now);
    } catch (error: unknown) {
      if (signal.aborted) return;
      log('scheduled_wake_failed', { machineId: machine.machineId, state: 'error', code: errorCode(error) });
      await backOff(row.machine_id, row.generation, row.wake_failures, now).catch((backOffError: unknown) => {
        log('scheduled_wake_backoff_failed', { machineId: machine.machineId, code: errorCode(backOffError) });
      });
    }
  }

  async function sleepOne(machine: UserMachineRecord, tickNow: Date, clock: () => Date, signal: AbortSignal): Promise<void> {
    // Bookkeeping (alerts, the guard stamp) uses the tick time; decisions use the current time.
    const tickMs = tickNow.getTime();
    // Only the resolved effective plan decides: an active override or a live
    // paid subscription for this slot wins over a stored free entitlement.
    const effective = await resolveEffectiveBillingEntitlementForSlot(
      db, machine.clerkUserId, clock(), machine.runtimeSlot, deps.env ?? process.env);
    if (effective?.source !== 'free') {
      log('sleep_skipped_paid', { machineId: machine.machineId });
      return;
    }
    let read: LifecycleRead;
    try {
      read = await deps.readLifecycle(machine, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      log('lifecycle_read_failed', { machineId: machine.machineId, code: errorCode(error) });
      noteUnavailable(machine.machineId, 'read_failed', tickMs);
      return;
    }
    // The current time, not the tick start: the wake phase and the read take time.
    const now = clock();
    const nowMs = now.getTime();
    if (!read.ok && read.code === 'asleep') {
      // The host already sleeps this VM (for example a suspend accepted just before a platform restart).
      // Record it asleep with its scheduled wake kept, so the wake pass picks it up.
      noteHealthy(machine.machineId);
      await markRuntimeAsleep(db, machine);
      log('sleep_recorded_host_asleep', { machineId: machine.machineId });
      return;
    }
    if (!read.ok) {
      noteUnavailable(machine.machineId, read.code, tickMs);
      return;
    }
    const verdict = decide(machine, read.status, nowMs);
    if (verdict.alert) noteUnavailable(machine.machineId, verdict.alert, tickMs);
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

    // Clears the saved wake, only once the VM is known to be running (never after an unconfirmed suspend).
    const release = () => db.executor.updateTable('user_machines').set({ next_wake_at: null })
      .where('machine_id', '=', machine.machineId)
      .where('generation', '=', machine.generation)
      .where('status', '=', 'running')
      .where('deleted_at', 'is', null)
      .execute();
    // Recheck the scheduled job against the time now: suspending inside the
    // wake lead would leave too little time to wake the VM for it.
    if (verdict.nextWakeAt && verdict.nextWakeAt.getTime() <= clock().getTime()) {
      log('sleep_skipped_deadline', { machineId: machine.machineId });
      await release();
      return;
    }
    let outcome: Awaited<ReturnType<OnDemandRuntimeSubstrate['stop']>>;
    try {
      outcome = await substrate.stop(refFor(machine), signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      // The answer may be lost after hostd suspended the VM: keep the saved wake for the asleep path.
      log('sleep_suspend_failed', { machineId: machine.machineId, code: errorCode(error) });
      return;
    }
    if (outcome.state === 'failed') {
      log('sleep_suspend_failed', { machineId: machine.machineId, code: outcome.code });
      return;
    }

    // Recorded only while still idle: owner activity that arrived during the
    // suspend cancels it below instead of leaving their work interrupted.
    const recorded = await db.executor.updateTable('user_machines')
      .set({ status: ASLEEP_STATUS, awake_since: null, wake_failures: 0, ...(verdict.guard ? { idle_guard_at: tickNow } : {}) })
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
    if (!recorded) {
      const current = await getUserMachine(db, machine.machineId);
      if (current && !current.deletedAt && current.generation === machine.generation && current.status === 'running') {
        // The owner came back during the suspend: resume the VM right away.
        log('sleep_cancelled_activity', { machineId: machine.machineId });
        const { result } = await wakeOnDemandRuntime(db, substrate, current, { now: clock, signal,
          log: (message, detail) => log('sleep_cancel_resume_error', { machineId: machine.machineId, message, ...detail }) });
        if (result.state === 'running') await release();
        else log('sleep_cancel_resume_pending', { machineId: machine.machineId, state: result.state });
        return;
      }
      // The host still sleeps the VM; the ingress reports it asleep and the next request wakes it.
      log('sleep_record_lost', { machineId: machine.machineId });
      return;
    }
    if (verdict.guard) log('idle_guard_suspended', { machineId: machine.machineId, busyReasons: read.status.busyReasons });
  }

  async function sleepIdle(now: Date, clock: () => Date, signal: AbortSignal): Promise<void> {
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
    const recheckBefore = new Date(nowMs - SLEEP_RECHECK_AFTER_MS);
    const startedAt = elapsedMs();
    const rows = await db.executor.selectFrom('user_machines as m').selectAll('m')
      .where('m.substrate', '=', 'metal')
      .where('m.status', '=', 'running')
      .where('m.deleted_at', 'is', null)
      .where('m.awake_since', '<=', settledBefore)
      .where((eb) => eb.or([eb('m.sleep_checked_at', 'is', null), eb('m.sleep_checked_at', '<=', recheckBefore)]))
      .where((eb) => eb.or([
        eb('m.last_activity_at', '<=', idleBefore),
        eb.and([eb('m.last_activity_at', 'is', null), eb('m.awake_since', '<=', idleBefore)]),
      ]))
      .where(ownedByFreePlan(now))
      .orderBy(sql`m.sleep_checked_at NULLS FIRST`)
      .orderBy(sql`coalesce(m.last_activity_at, m.awake_since)`).orderBy('m.machine_id')
      .limit(SLEEP_CANDIDATES_PER_TICK)
      .execute();
    for (const row of rows) {
      if (signal.aborted) return;
      if (elapsedMs() - startedAt >= SLEEP_PASS_BUDGET_MS) {
        log('sleep_pass_budget_spent', { remaining: rows.length - rows.indexOf(row) });
        return;
      }
      const machine = mapUserMachine(row);
      try {
        // Stamped before the check, so a runtime that fails or is skipped rotates behind the others.
        const stamped = await db.executor.updateTable('user_machines').set({ sleep_checked_at: now })
          .where('machine_id', '=', machine.machineId)
          .where('generation', '=', machine.generation)
          .where('status', '=', 'running')
          .where('deleted_at', 'is', null)
          .returning('machine_id')
          .executeTakeFirst();
        if (!stamped) continue;
        await sleepOne(machine, now, clock, signal);
      } catch (error: unknown) {
        if (signal.aborted) return;
        log('sleep_machine_failed', { machineId: machine.machineId, code: errorCode(error) });
      }
    }
  }

  async function pass(now: Date, signal: AbortSignal): Promise<void> {
    const passStart = elapsedMs();
    const clock = () => new Date(now.getTime() + Math.max(0, elapsedMs() - passStart));
    await db.ready;
    await wakeDue(now, signal);
    if (!signal.aborted) await sleepIdle(now, clock, signal);
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
  /** Runs a tick only while holding a cluster-wide lock (see metal-singleton.ts). */
  singleton?: (run: () => Promise<void>) => Promise<unknown>;
  log?: Log;
}): MetalSleeperWorker {
  const log = input.log ?? defaultLog;
  const now = input.now ?? (() => new Date());
  const controller = new AbortController();
  let inFlight: Promise<void> | undefined;

  const tick = (): void => {
    if (controller.signal.aborted || inFlight) return;
    const run = async (): Promise<void> => { await input.sleeper.tick(now(), controller.signal); };
    const current = (input.singleton ? input.singleton(run).then(() => undefined) : run())
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
