import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import type { StorageQuota } from './storage-quota.js';

/**
 * Recurring reconciliation of expired pending storage writes (spec 2691 US4).
 * A signed upload that never landed holds quota until it is reconciled, and
 * without this sweep that only happens when the owner's next write is refused.
 * Owners whose expired pending writes are oldest go first; each gets the
 * quota's own bounded reconcile pass. A session advisory lock on one pinned
 * connection keeps one sweep running across platform instances.
 */

export interface StorageQuotaSweeperDeps {
  db: PlatformDB;
  quota: Pick<StorageQuota, 'reconcile'>;
  intervalMs?: number;
  /** Owners reconciled per run. */
  ownerBatch?: number;
  /** No new owner is started after this much time in one run. */
  budgetMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  logError?: (message: string, detail: Record<string, string>) => void;
}

export interface StorageQuotaSweepResult {
  /** False when another platform instance holds the sweep. */
  ran: boolean;
  owners: number;
  settled: number;
}

const QUOTA_SWEEP_INTERVAL_MS = 5 * 60_000;
const QUOTA_SWEEP_OWNERS = 50;
const QUOTA_SWEEP_BUDGET_MS = 60_000;
const SWEEP_LOCK_KEY = 'matrix:storage-quota:pending-sweep';
/** Owners whose reconcile made no progress are skipped for a doubling interval, up to an hour. */
const MAX_BACKOFF_MS = 60 * 60_000;
const MAX_BACKED_OFF_OWNERS = 10_000;
/** Candidates read per run, so owners behind backed-off ones still fill the batch. */
const CANDIDATE_FACTOR = 4;

export function createStorageQuotaSweeper(deps: StorageQuotaSweeperDeps) {
  const intervalMs = deps.intervalMs ?? QUOTA_SWEEP_INTERVAL_MS;
  const ownerBatch = deps.ownerBatch ?? QUOTA_SWEEP_OWNERS;
  const budgetMs = deps.budgetMs ?? QUOTA_SWEEP_BUDGET_MS;
  const now = deps.now ?? (() => new Date());
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<StorageQuotaSweepResult> | null = null;
  /** Per owner: consecutive failed attempts and when the next attempt may run. */
  const backoff = new Map<string, { failures: number; retryAt: number }>();

  function noteOutcome(owner: string, progressed: boolean): void {
    const prior = backoff.get(owner);
    backoff.delete(owner);
    if (progressed) return;
    const failures = (prior?.failures ?? 0) + 1;
    backoff.set(owner, { failures, retryAt: now().getTime() + Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** (failures - 1)) });
    while (backoff.size > MAX_BACKED_OFF_OWNERS) backoff.delete(backoff.keys().next().value!);
  }

  async function reconcileBatch(): Promise<Omit<StorageQuotaSweepResult, 'ran'>> {
    const owners = await deps.db.executor.selectFrom('runtime_storage_objects').select('clerk_user_id')
      .where('pending_until', 'is not', null).where('pending_until', '<', now())
      .groupBy('clerk_user_id').orderBy(sql`min(pending_until)`).orderBy('clerk_user_id')
      .limit(ownerBatch * CANDIDATE_FACTOR).execute()
      .then((rows) => rows.filter(({ clerk_user_id: owner }) => (backoff.get(owner)?.retryAt ?? 0) <= now().getTime())
        .slice(0, ownerBatch));
    const started = monotonicNow();
    let attempted = 0;
    let settled = 0;
    for (const { clerk_user_id: owner } of owners) {
      if (monotonicNow() - started >= budgetMs) break;
      attempted += 1;
      try {
        const count = await deps.quota.reconcile(owner);
        settled += count;
        noteOutcome(owner, count > 0);
      } catch (error: unknown) {
        noteOutcome(owner, false);
        logError('[storage-quota] sweep reconcile failed', { cause: error instanceof Error ? error.name : 'unknown' });
      }
    }
    return { owners: attempted, settled };
  }

  async function sweepOnce(): Promise<StorageQuotaSweepResult> {
    return deps.db.kysely.connection().execute(async (connection) => {
      const lock = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${SWEEP_LOCK_KEY}, 0)) AS locked`
        .execute(connection);
      if (!lock.rows[0]?.locked) return { ran: false, owners: 0, settled: 0 };
      try {
        return { ran: true, ...await reconcileBatch() };
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${SWEEP_LOCK_KEY}, 0))`.execute(connection);
      }
    });
  }

  function tick(): void {
    if (running) return;
    running = sweepOnce().catch((error: unknown) => {
      logError('[storage-quota] sweep failed', { cause: error instanceof Error ? error.name : 'unknown' });
      return { ran: false, owners: 0, settled: 0 };
    }).finally(() => { running = null; });
  }

  return {
    sweepOnce,
    start(): void {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    async shutdown(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
  };
}
