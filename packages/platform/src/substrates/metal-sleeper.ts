import { setTimeout as delay } from 'node:timers/promises';
import { sql, type ExpressionBuilder, type Selectable } from 'kysely';
import type { RuntimeLifecycleStatus } from '@matrix-os/contracts/runtime-lifecycle';
import { mapUserMachine } from '../database/user-machine-records.js';
import { getUserMachine } from '../database/user-machines.js';
import type { PlatformDatabase, PlatformDB, UserMachineRecord } from '../db.js';
import { getAccountDeletionAdmission, withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import { getRuntimeAccessDecision } from '../billing.js';
import { getRuntimeEntitlementDecisionForUser } from '../runtime-entitlement.js';
import { resolveEffectiveBillingEntitlementForSlot } from '../billing-entitlement-resolver.js';
import { wakeAfterSuspendAttempt, wakeOnDemandRuntime } from './substrate-wake.js';
import type { OnDemandRuntimeSubstrate, RuntimeRef } from './types.js';
import type { LifecycleRead } from './metal-lifecycle-reader.js';

/**
 * Idle sleep and scheduled wake for free metal runtimes (spec 2691, ENG-520
 * Task P6). Scheduled wakes and idle sleep run on independent worker lanes:
 *
 * - A candidate is a running free metal runtime with no owner activity for
 *   60 minutes (or none ever, and awake for 60 minutes).
 * - The runtime's own lifecycle answer decides. It never sleeps while busy, on
 *   an `unknown` busy source, or on an incomplete schedule. The 6 h idle guard
 *   overrides only known busy reasons: awake 6 h with no owner activity for
 *   6 h suspends it and stamps `idle_guard_at`.
 * - `next_wake_at` (2 min before the next scheduled job) is recorded before the
 *   suspend; a wake time already past means the runtime stays awake.
 * - Any lifecycle failure (timeout, non-2xx, schema failure) skips the runtime
 *   for this tick. Paid runtimes are never put to sleep; a wake saved while
 *   free is still honored after an upgrade.
 *
 * Every state change is a compare-and-set on (status, generation), so a
 * runtime replaced, deleted, or woken concurrently is never overwritten.
 */

export const METAL_SLEEP_INTERVAL_MS = 60_000;
export const METAL_WAKE_INTERVAL_MS = 5_000;
export const IDLE_SLEEP_AFTER_MS = 60 * 60_000;
export const IDLE_GUARD_AFTER_MS = 6 * 60 * 60_000;
/**
 * No new batch of due wakes is fetched once this long has passed since the wake
 * pass began; the rest wait for the next scan.
 */
export const WAKE_PASS_BUDGET_MS = 30_000;
/**
 * Leave time for several bounded wake batches and the short gaps between scans
 * before the job is due.
 */
export const SCHEDULED_WAKE_LEAD_MS = 2 * 60_000;
/**
 * A just-woken runtime gets this long to start the job it was woken for
 * before it may sleep again (its next scheduled time may already be past).
 */
export const WAKE_SETTLE_MS = 5 * 60_000;
export const LIFECYCLE_ALERT_AFTER_MS = 6 * 60 * 60_000;
export const LIFECYCLE_ALERT_REPEAT_MS = 60 * 60_000;
export const SLEEP_CANDIDATES_PER_TICK = 50;
/** Due wakes are fetched in batches of this size, drained until none are due or the wake pass budget is spent. */
export const WAKES_PER_TICK = 20;
/** Every due wake of a batch runs at once, so each batch takes at most one wake timeout (25 s). */
export const WAKE_CONCURRENCY = 20;
/** A checked candidate rotates behind the others until this long has passed, so runtimes skipped every tick cannot starve the scan. */
export const SLEEP_RECHECK_AFTER_MS = 5 * 60_000;
/**
 * No sleep candidate starts once this long has passed since the sleep pass began.
 * Scheduled wakes run independently, even during a slow suspend or its recovery.
 */
export const SLEEP_PASS_BUDGET_MS = 30_000;
/** The platform waits this long for hostd's suspend answer; a late answer is handled as a lost one. */
export const SUSPEND_WAIT_MS = 15_000;
const SUSPEND_POLL_INTERVAL_MS = 500;
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
  /** Overrides SUSPEND_WAIT_MS (tests). */
  suspendWaitMs?: number;
  /**
   * The `free-tier-sleep` PostHog switch (ENG-608) per owner. False skips the
   * suspend; scheduled wakes and resuming still run. Absent means sleep is on.
   */
  sleepAllowed?: (clerkUserId: string) => Promise<boolean>;
}

export interface MetalSleeper {
  /** Runs a complete pass, with wakes first. */
  tick(now: Date, signal?: AbortSignal): Promise<void>;
  wakeTick(now: Date, signal?: AbortSignal): Promise<void>;
  sleepTick(now: Date, signal?: AbortSignal): Promise<void>;
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

  type SleepRow = Selectable<PlatformDatabase['user_machines']>;

  function updateSavedWake(row: SleepRow, changes: {
    next_wake_at: Date | null; wake_failures?: number; awake_since?: Date;
  }) {
    return db.executor.updateTable('user_machines').set(changes)
      .where('machine_id', '=', row.machine_id)
      .where('generation', '=', row.generation)
      .where('status', '=', row.status)
      .where('next_wake_at', row.next_wake_at === null ? 'is' : '=', row.next_wake_at)
      .where('wake_failures', '=', row.wake_failures)
      .where('deleted_at', 'is', null);
  }

  /** Moves a failed wake behind fresh ones: retry after 1, 2, 4 … minutes, at most 15. */
  async function backOff(row: SleepRow, now: Date): Promise<void> {
    const delay = Math.min(WAKE_RETRY_BASE_MS * 2 ** Math.min(row.wake_failures, 16), WAKE_RETRY_MAX_MS);
    await updateSavedWake(row, {
      next_wake_at: new Date(now.getTime() + delay), wake_failures: row.wake_failures + 1,
    }).execute();
  }

  async function wakeDue(now: Date, signal: AbortSignal): Promise<void> {
    const passStart = elapsedMs();
    // Keyset cursor over (next_wake_at, machine_id): each due row is tried at most
    // once per pass, even when its wake leaves the row unchanged.
    type Cursor = { nextWakeAt: Date; machineId: string };
    let after: Cursor | null = null;
    while (!signal.aborted) {
      const cursor: Cursor | null = after;
      const rows: SleepRow[] = await db.executor.selectFrom('user_machines as m').selectAll('m')
        .where('m.substrate', '=', 'metal')
        .where('m.status', 'in', [ASLEEP_STATUS, 'running'])
        .where('m.deleted_at', 'is', null)
        .where('m.next_wake_at', '<=', now)
        .$if(cursor !== null, (query) => query.where(
          sql<boolean>`(m.next_wake_at, m.machine_id) > (${cursor!.nextWakeAt}, ${cursor!.machineId})`))
        // Keep scheduled wakes after upgrades. wakeOne checks whether current access permits starting the runtime.
        .orderBy('m.next_wake_at').orderBy('m.machine_id')
        .limit(WAKES_PER_TICK)
        .execute();
      await wakeBatch(rows, now, signal);
      const last: SleepRow | undefined = rows.at(-1);
      if (rows.length < WAKES_PER_TICK || !last?.next_wake_at) return;
      if (elapsedMs() - passStart >= WAKE_PASS_BUDGET_MS) {
        log('scheduled_wake_budget_spent', { budgetMs: WAKE_PASS_BUDGET_MS });
        return;
      }
      after = { nextWakeAt: last.next_wake_at, machineId: last.machine_id };
    }
  }

  async function wakeBatch(rows: SleepRow[], now: Date, signal: AbortSignal): Promise<void> {
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

  async function wakeOne(row: SleepRow, now: Date, signal: AbortSignal): Promise<void> {
    if (signal.aborted || row.next_wake_at === null) return;
    const machine = mapUserMachine(row);
    try {
      const access = await getRuntimeEntitlementDecisionForUser(
        db, machine.clerkUserId, deps.env ?? process.env, machine.runtimeSlot, machine.provisioningClass, now);
      if (!access.runtimeProxyAllowed) {
        await backOff(row, now);
        return;
      }
      const { result } = await wakeOnDemandRuntime(db, substrate, machine, {
        now: () => now,
        signal,
        log: (message, detail) => log('scheduled_wake_error', { machineId: machine.machineId, message, ...detail }),
      });
      if (result.state === 'running') {
        // Owner-routing wakes leave running rows unchanged. Consume this saved wake only
        // after the host confirms readiness, even when the suspend went unconfirmed.
        if (machine.status === 'running') {
          await updateSavedWake(row, { next_wake_at: null, wake_failures: 0, awake_since: now }).execute();
        }
        return;
      }
      if (result.state === 'failed' && result.code === 'needs_recovery') {
        // Retrying cannot help and would hold a wake slot every tick; an operator must recover it.
        await updateSavedWake(row, { next_wake_at: null }).execute();
        log('scheduled_wake_needs_recovery', { machineId: machine.machineId });
        return;
      }
      log('scheduled_wake_failed', {
        machineId: machine.machineId, state: result.state, ...(result.state === 'failed' ? { code: result.code } : {}),
      });
      await backOff(row, now);
    } catch (error: unknown) {
      if (signal.aborted) return;
      log('scheduled_wake_failed', { machineId: machine.machineId, state: 'error', code: errorCode(error) });
      await backOff(row, now).catch((backOffError: unknown) => {
        log('scheduled_wake_backoff_failed', { machineId: machine.machineId, code: errorCode(backOffError) });
      });
    }
  }

  async function sleepOne(machine: UserMachineRecord, tickNow: Date, clock: () => Date, signal: AbortSignal): Promise<void> {
    // Bookkeeping (alerts, the guard stamp) uses the tick time; decisions use the current time.
    const tickMs = tickNow.getTime();
    const env = deps.env ?? process.env;
    const deletion = await getAccountDeletionAdmission(db, machine.clerkUserId, env, clock());
    if (deletion.runtimeAccess !== 'normal') return;

    // An active override or a live paid subscription wins over a stored free entitlement.
    const resolvePlan = (source: PlatformDB, at = clock()) => resolveEffectiveBillingEntitlementForSlot(
      source, machine.clerkUserId, at, machine.runtimeSlot, env);
    if ((await resolvePlan(db))?.source !== 'free') {
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
      // Ingress also returns asleep during transitions. Confirm with the
      // provider before recording sleep after a late suspend or a restart.
      if (!await substrate.isSuspended(refFor(machine), signal)) return;
      noteHealthy(machine.machineId);
      // A scheduled wake can complete while the host read is in flight and
      // leave the machine running with a new awake stamp and wake time.
      const previousWake = machine.nextWakeAt === null ? null : new Date(machine.nextWakeAt);
      const previousAwake = machine.awakeSince === null ? null : new Date(machine.awakeSince);
      const recorded = await db.executor.updateTable('user_machines')
        .set({ status: 'suspended' })
        .where('machine_id', '=', machine.machineId)
        .where('generation', '=', machine.generation)
        .where('status', '=', 'running')
        .where('deleted_at', 'is', null)
        .where('next_wake_at', previousWake === null ? 'is' : '=', previousWake)
        .where('awake_since', previousAwake === null ? 'is' : '=', previousAwake)
        .returning('machine_id')
        .executeTakeFirst();
      if (recorded) log('sleep_recorded_host_asleep', { machineId: machine.machineId });
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
    const previousWake = machine.nextWakeAt === null ? null : new Date(machine.nextWakeAt);
    const claimed = await db.executor.updateTable('user_machines')
      .set({ next_wake_at: verdict.nextWakeAt })
      .where('next_wake_at', previousWake === null ? 'is' : '=', previousWake)
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
      .where('next_wake_at', verdict.nextWakeAt === null ? 'is' : '=', verdict.nextWakeAt)
      .where('deleted_at', 'is', null)
      .execute();
    // Activity can land after the claim. Avoid stopping a guest that has
    // already resumed work, and keep the post-stop guard for activity in flight.
    const beforeStop = await getUserMachine(db, machine.machineId);
    if (!beforeStop || beforeStop.deletedAt || beforeStop.generation !== machine.generation
      || beforeStop.status !== 'running' || ms(beforeStop.nextWakeAt) !== (verdict.nextWakeAt?.getTime() ?? null)) return;
    const lastWorkedAt = ms(beforeStop.lastActivityAt ?? beforeStop.awakeSince);
    if (lastWorkedAt === null || lastWorkedAt > idleBefore.getTime()) {
      log('sleep_skipped_changed', { machineId: machine.machineId });
      await release();
      return;
    }
    if ((await resolvePlan(db))?.source !== 'free') {
      log('sleep_skipped_paid', { machineId: machine.machineId });
      await release();
      return;
    }
    // Check the deadline after the final database read so hostd still has the lead time.
    if (verdict.nextWakeAt && verdict.nextWakeAt.getTime() <= clock().getTime()) {
      log('sleep_skipped_deadline', { machineId: machine.machineId });
      await release();
      return;
    }
    let accepted = false;
    let suspended = false;
    try {
      const ref = refFor(machine);
      const suspendSignal = AbortSignal.any([signal, AbortSignal.timeout(deps.suspendWaitMs ?? SUSPEND_WAIT_MS)]);
      const outcome = await substrate.stop(ref, suspendSignal);
      if (outcome.state === 'failed') {
        log('sleep_suspend_failed', { machineId: machine.machineId, code: outcome.code });
      } else {
        accepted = true;
        // Hostd answers 202 before snapshotting. Only its subsequent VM state
        // can confirm sleep, within the same bounded wait.
        while (!(suspended = await substrate.isSuspended(ref, suspendSignal))) {
          await delay(SUSPEND_POLL_INTERVAL_MS, undefined, { signal: suspendSignal });
        }
      }
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      log('sleep_suspend_failed', { machineId: machine.machineId, code: errorCode(error) });
    }
    // A due wake may have run while the suspend request traveled to hostd.
    // Favor readiness at its deadline even when the suspend reply was lost.
    const due = verdict.nextWakeAt !== null && verdict.nextWakeAt.getTime() <= clock().getTime();
    // Serialize the final state change with billing writes. Host calls stay outside this lock.
    const awakeWhenClaimed = beforeStop.awakeSince === null ? null : new Date(beforeStop.awakeSince);
    const completion = await withAccountDeletionOwnerLock(db, machine.clerkUserId, async (trx, admission) => {
      const at = clock();
      const effective = await resolvePlan(trx, at);
      if (effective?.source !== 'free' || admission.runtimeAccess !== 'normal') {
        const canResume = admission.runtimeAccess === 'grace'
          || (admission.runtimeAccess === 'normal' && getRuntimeAccessDecision(effective, at).runtimeProxyAllowed);
        // Persist a retry before attempting compensation, even for VMs with no scheduled jobs.
        const recovery = canResume ? await trx.executor.updateTable('user_machines')
          .set({ next_wake_at: suspended ? at : new Date(at.getTime() + WAKE_RETRY_BASE_MS), wake_failures: 0 })
          .where('machine_id', '=', machine.machineId)
          .where('generation', '=', machine.generation)
          .where('status', 'in', ['running', ASLEEP_STATUS])
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst() : undefined;
        return { kind: 'changed' as const, recovery };
      }
      // Record sleep only if no owner activity or scheduled wake won while hostd was suspending.
      const recorded = suspended && !due && await trx.executor.updateTable('user_machines')
        .set({ status: ASLEEP_STATUS, awake_since: null, wake_failures: 0, ...(verdict.guard ? { idle_guard_at: tickNow } : {}) })
        .where('machine_id', '=', machine.machineId)
        .where('generation', '=', machine.generation)
        .where('status', '=', 'running')
        .where('next_wake_at', verdict.nextWakeAt === null ? 'is' : '=', verdict.nextWakeAt)
        .where('awake_since', awakeWhenClaimed === null ? 'is' : '=', awakeWhenClaimed)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([
          eb('last_activity_at', '<=', idleBefore),
          eb.and([eb('last_activity_at', 'is', null), eb('awake_since', '<=', idleBefore)]),
        ]))
        .returning('machine_id')
        .executeTakeFirst();
      return { kind: 'free' as const, recorded };
    }, env);
    if (completion.kind === 'changed') {
      if (!completion.recovery) return;
      const recovery = completion.recovery;
      const { result } = await wakeAfterSuspendAttempt(db, substrate, mapUserMachine(recovery), { now: clock, signal,
        log: (message, detail) => log('sleep_cancel_resume_error', { machineId: machine.machineId, message, ...detail }) });
      // If suspension was unconfirmed, keep the delayed verification even when the first resume sees a running VM.
      if (suspended && result.state === 'running') {
        await updateSavedWake(recovery, { next_wake_at: null, wake_failures: 0, awake_since: clock() }).execute();
      }
      return;
    }
    if (!accepted && !due) return;
    const { recorded } = completion;
    if (!recorded) {
      const current = await getUserMachine(db, machine.machineId);
      if (current && !current.deletedAt && current.generation === machine.generation && current.status === 'running') {
        const lastWorkedAt = ms(current.lastActivityAt ?? current.awakeSince);
        if (!suspended && !due && (lastWorkedAt === null || lastWorkedAt <= idleBefore.getTime())) return;
        // An owner request or a scheduled wake beat the suspend. The next
        // resume must go to hostd after this suspend attempt.
        log(due ? 'sleep_cancelled_scheduled_wake' : 'sleep_cancelled_activity', { machineId: machine.machineId });
        const { result } = await wakeAfterSuspendAttempt(db, substrate, current, { now: clock, signal,
          log: (message, detail) => log('sleep_cancel_resume_error', { machineId: machine.machineId, message, ...detail }) });
        if (suspended && result.state === 'running') {
          await release();
        } else if (verdict.nextWakeAt !== null && current.nextWakeAt === null) {
          // Restore the durable retry if the earlier wake consumed it but the
          // compensation is pending, or the suspend itself is still uncertain.
          const awake = current.awakeSince === null ? null : new Date(current.awakeSince);
          await db.executor.updateTable('user_machines').set({ next_wake_at: verdict.nextWakeAt, wake_failures: 0 })
            .where('machine_id', '=', current.machineId).where('generation', '=', current.generation)
            .where('status', '=', 'running').where('deleted_at', 'is', null)
            .where('awake_since', awake === null ? 'is' : '=', awake).where('next_wake_at', 'is', null).execute();
        }
        if (result.state !== 'running') log('sleep_cancel_resume_pending', { machineId: machine.machineId, state: result.state });
        return;
      }
      // The host still sleeps the VM; the ingress reports it asleep and the next request wakes it.
      log('sleep_record_lost', { machineId: machine.machineId });
      return;
    }
    if (verdict.guard) log('idle_guard_suspended', { machineId: machine.machineId, busyReasons: read.status.busyReasons });
  }

  async function sleepIdle(now: Date, clock: () => Date, startedAt: number, signal: AbortSignal): Promise<void> {
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
    const flagRecheckStamp = new Date(nowMs - SLEEP_RECHECK_AFTER_MS + METAL_SLEEP_INTERVAL_MS);
    const rows = await db.executor.selectFrom('user_machines as m').selectAll('m')
      .where('m.substrate', '=', 'metal')
      .where('m.status', '=', 'running')
      .where('m.deleted_at', 'is', null)
      .where('m.awake_since', '<=', settledBefore)
      .where((eb) => eb.or([eb('m.next_wake_at', 'is', null), eb('m.next_wake_at', '>', now)]))
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
        const sleepAllowed = !deps.sleepAllowed || await deps.sleepAllowed(machine.clerkUserId);
        // Stamped before the check, so a runtime that fails or is skipped rotates behind the others.
        // A runtime skipped only because `free-tier-sleep` is off is due again after one interval,
        // so turning the flag on takes effect on the next pass while the scan still rotates.
        const stamped = await db.executor.updateTable('user_machines')
          .set({ sleep_checked_at: sleepAllowed ? now : flagRecheckStamp })
          .where('machine_id', '=', machine.machineId)
          .where('generation', '=', machine.generation)
          .where('status', '=', 'running')
          .where('deleted_at', 'is', null)
          .returning('machine_id')
          .executeTakeFirst();
        if (!stamped) continue;
        if (!sleepAllowed) {
          log('sleep_skipped_flag', { machineId: machine.machineId });
          continue;
        }
        await sleepOne(machine, now, clock, signal);
      } catch (error: unknown) {
        if (signal.aborted) return;
        log('sleep_machine_failed', { machineId: machine.machineId, code: errorCode(error) });
      }
    }
  }

  async function wakeTick(now: Date, signal = new AbortController().signal): Promise<void> {
    await db.ready;
    await wakeDue(now, signal);
  }

  async function sleepTick(now: Date, signal = new AbortController().signal, passStart = elapsedMs()): Promise<void> {
    const clock = () => new Date(now.getTime() + Math.max(0, elapsedMs() - passStart));
    await db.ready;
    if (!signal.aborted) await sleepIdle(now, clock, passStart, signal);
  }

  async function pass(now: Date, signal: AbortSignal): Promise<void> {
    const passStart = elapsedMs();
    await wakeTick(now, signal);
    await sleepTick(now, signal, passStart);
  }

  return {
    wakeTick,
    sleepTick,
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

/** Ticks now and every `intervalMs`; a busy lane skips its next tick independently. */
export function startMetalSleeperWorker(input: {
  sleeper: Pick<MetalSleeper, 'tick'>;
  scheduledWake?: { tick: MetalSleeper['tick']; singleton?: (run: () => Promise<void>) => Promise<unknown> };
  intervalMs?: number;
  now?: () => Date;
  /** Runs a tick only while holding a cluster-wide lock (see metal-singleton.ts). */
  singleton?: (run: () => Promise<void>) => Promise<unknown>;
  log?: Log;
}): MetalSleeperWorker {
  const log = input.log ?? defaultLog;
  const now = input.now ?? (() => new Date());
  const controller = new AbortController();
  function lane(runTick: MetalSleeper['tick'], singleton?: (run: () => Promise<void>) => Promise<unknown>) {
    let inFlight: Promise<void> | undefined;
    return {
      tick(): void {
        if (controller.signal.aborted || inFlight) return;
        const run = () => runTick(now(), controller.signal);
        inFlight = (singleton ? singleton(run).then(() => undefined) : run())
          .catch((error: unknown) => {
            if (!controller.signal.aborted) log('sleeper_tick_failed', { code: errorCode(error) });
          })
          .finally(() => { inFlight = undefined; });
      },
      drain: () => inFlight,
    };
  }

  const sleep = lane(input.sleeper.tick, input.singleton);
  const wake = input.scheduledWake && lane(input.scheduledWake.tick, input.scheduledWake.singleton);
  wake?.tick();
  sleep.tick();
  const interval = setInterval(sleep.tick, input.intervalMs ?? METAL_SLEEP_INTERVAL_MS);
  interval.unref?.();
  // A wake pass may exhaust its budget after fetching some of the due rows.
  // Check again promptly so the remaining rows have time to resume.
  const wakeInterval = wake && setInterval(wake.tick, input.intervalMs ?? METAL_WAKE_INTERVAL_MS);
  wakeInterval?.unref?.();
  return {
    stop() {
      clearInterval(interval);
      if (wakeInterval) clearInterval(wakeInterval);
      controller.abort();
    },
    async drain() {
      await Promise.all([wake?.drain(), sleep.drain()]);
    },
  };
}
