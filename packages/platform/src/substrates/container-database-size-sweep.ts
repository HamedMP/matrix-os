import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { ContainerOwnerDatabaseError, type ContainerOwnerDatabases } from './container-owner-database.js';

export interface OwnerDatabaseSizeSweeperDeps {
  db: PlatformDB;
  ownerDatabases: Pick<ContainerOwnerDatabases, 'enforceSizeLimit'>;
  intervalMs?: number;
  batchSize?: number;
  logError?: (message: string, detail: Record<string, string>) => void;
}

export interface SizeSweepResult {
  /** False when another platform instance holds the sweep. */
  ran: boolean;
  enforced: number;
}

const SIZE_SWEEP_INTERVAL_MS = 5 * 60_000;
const SIZE_SWEEP_BATCH = 50;
const SIZE_ENFORCE_TIMEOUT_MS = 30_000;
const SWEEP_LOCK_KEY = 'matrix:container-owner-db:size-sweep';

/**
 * Recurring size enforcement over active owner databases, least recently
 * measured first, in bounded batches. A session advisory lock on one pinned
 * connection keeps a single sweep running across platform instances; it is
 * released at the end of the run, or by Postgres if the connection dies.
 */
export function createOwnerDatabaseSizeSweeper(deps: OwnerDatabaseSizeSweeperDeps) {
  const intervalMs = deps.intervalMs ?? SIZE_SWEEP_INTERVAL_MS;
  const batchSize = deps.batchSize ?? SIZE_SWEEP_BATCH;
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<SizeSweepResult> | null = null;

  async function enforceBatch(): Promise<number> {
    const rows = await deps.db.executor.selectFrom('container_owner_databases').select('clerk_user_id')
      .where('state', '=', 'active').where('deleted_at', 'is', null)
      .orderBy(sql`size_measured_at ASC NULLS FIRST`).limit(batchSize).execute();
    let enforced = 0;
    for (const row of rows) {
      try {
        await deps.ownerDatabases.enforceSizeLimit(row.clerk_user_id, AbortSignal.timeout(SIZE_ENFORCE_TIMEOUT_MS));
        enforced += 1;
      } catch (error: unknown) {
        logError('[container-owner-db] size enforcement failed', {
          cause: error instanceof ContainerOwnerDatabaseError ? error.code : error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    return enforced;
  }

  async function sweepOnce(): Promise<SizeSweepResult> {
    return deps.db.kysely.connection().execute(async (connection) => {
      const lock = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${SWEEP_LOCK_KEY}, 0)) AS locked`
        .execute(connection);
      if (!lock.rows[0]?.locked) return { ran: false, enforced: 0 };
      try {
        return { ran: true, enforced: await enforceBatch() };
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${SWEEP_LOCK_KEY}, 0))`.execute(connection);
      }
    });
  }

  function tick(): void {
    if (running) return;
    running = sweepOnce().catch((error: unknown) => {
      logError('[container-owner-db] size sweep failed', { cause: error instanceof Error ? error.name : 'unknown' });
      return { ran: false, enforced: 0 };
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
