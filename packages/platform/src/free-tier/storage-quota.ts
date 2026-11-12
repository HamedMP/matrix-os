import { randomUUID } from 'node:crypto';
import { sql, type ColumnType } from 'kysely';
import type { PlatformDB } from '../db.js';

/**
 * Per-owner object-store quota for container runtimes (spec 2691 US4, FR-022).
 *
 * Every mutation first locks the owner's usage row, so the per-key ledger it
 * reads next is current; the conditional UPDATE that moves the counter is the
 * statement that authorizes the write, and it refuses when either limit would
 * be passed. A write the broker cannot see land (a signed upload, a proxied
 * body still streaming) stays pending until it is confirmed or, after it
 * expires, reconciled against the store: present objects keep their real
 * size, absent ones release their bytes.
 */

export interface RuntimeStorageUsageTable {
  clerk_user_id: string;
  object_bytes: ColumnType<number | string, number | undefined, number>;
  object_count: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface RuntimeStorageObjectsTable {
  clerk_user_id: string;
  object_key: string;
  bytes: ColumnType<number | string, number, number>;
  counts_as_file: boolean;
  reservation_id: string;
  pending_until: ColumnType<Date | null, Date | string | null, Date | string | null>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface StorageQuotaLimits {
  maxBytes: number;
  maxFiles: number;
}

/** Provisional per-owner defaults from spec.md (home size 2 GiB, 50,000 files). */
export const DEFAULT_STORAGE_QUOTA_LIMITS: StorageQuotaLimits = { maxBytes: 2 * 1024 ** 3, maxFiles: 50_000 };

export type StorageQuotaRefusal = 'storage_full' | 'file_limit_reached';

export type StorageQuotaDecision =
  | { ok: true; reservationId: string }
  | { ok: false; code: StorageQuotaRefusal; priorExisted: boolean };

export interface StorageWrite {
  key: string;
  bytes: number;
  countsAsFile: boolean;
  /** How long the write may take to land; null when it already has. */
  pendingMs: number | null;
}

export interface StorageQuotaDeps {
  db: PlatformDB;
  limits: StorageQuotaLimits;
  headObject(key: string, options: { signal: AbortSignal }): Promise<{ exists: boolean; contentLength?: number }>;
  now?: () => Date;
  logError?: (message: string, detail: Record<string, string>) => void;
}

const MAX_KEY_LENGTH = 1024;
const RECONCILE_BATCH = 20;
const HEAD_TIMEOUT_MS = 5_000;
/** A refused write waits at most this long for reconciliation before its refusal stands. */
const RECONCILE_BUDGET_MS = 15_000;

type Executor = PlatformDB['executor'];

export function assertStorageQuotaLimits(limits: StorageQuotaLimits): StorageQuotaLimits {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
    || !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1) {
    throw new Error('Storage quota limits are invalid');
  }
  return limits;
}

async function lockUsage(executor: Executor, ownerId: string): Promise<{ bytes: number; count: number }> {
  await sql`INSERT INTO runtime_storage_usage (clerk_user_id) VALUES (${ownerId})
    ON CONFLICT (clerk_user_id) DO NOTHING`.execute(executor);
  const row = await executor.selectFrom('runtime_storage_usage').select(['object_bytes', 'object_count'])
    .where('clerk_user_id', '=', ownerId).forUpdate().executeTakeFirstOrThrow();
  return { bytes: Number(row.object_bytes), count: row.object_count };
}

export function createStorageQuota(deps: StorageQuotaDeps) {
  const { db } = deps;
  const limits = assertStorageQuotaLimits(deps.limits);
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));

  function assertWrite(write: StorageWrite): void {
    if (write.key.length < 1 || write.key.length > MAX_KEY_LENGTH
      || !Number.isSafeInteger(write.bytes) || write.bytes < 0) {
      throw new Error('Storage quota write is invalid');
    }
  }

  async function tryAuthorize(ownerId: string, write: StorageWrite): Promise<StorageQuotaDecision> {
    const reservationId = randomUUID();
    const pendingUntil = write.pendingMs === null ? null : new Date(now().getTime() + write.pendingMs).toISOString();
    return db.transaction(async (trx): Promise<StorageQuotaDecision> => {
      const usage = await lockUsage(trx.executor, ownerId);
      const authorized = await sql<{ prior_existed: boolean }>`
        WITH prior AS (
          SELECT bytes, counts_as_file FROM runtime_storage_objects
          WHERE clerk_user_id = ${ownerId} AND object_key = ${write.key}
        ), delta AS (
          SELECT ${write.bytes}::bigint - COALESCE((SELECT bytes FROM prior), 0) AS bytes,
            (CASE WHEN ${write.countsAsFile}::boolean THEN 1 ELSE 0 END)
              - COALESCE((SELECT CASE WHEN counts_as_file THEN 1 ELSE 0 END FROM prior), 0) AS files,
            EXISTS (SELECT 1 FROM prior) AS prior_existed
        ), counted AS (
          UPDATE runtime_storage_usage u
          SET object_bytes = u.object_bytes + d.bytes, object_count = u.object_count + d.files, updated_at = now()
          FROM delta d
          WHERE u.clerk_user_id = ${ownerId}
            AND (d.bytes <= 0 OR u.object_bytes + d.bytes <= ${limits.maxBytes})
            AND (d.files <= 0 OR u.object_count + d.files <= ${limits.maxFiles})
          RETURNING d.prior_existed
        ), recorded AS (
          INSERT INTO runtime_storage_objects
            (clerk_user_id, object_key, bytes, counts_as_file, reservation_id, pending_until, updated_at)
          SELECT ${ownerId}, ${write.key}, ${write.bytes}, ${write.countsAsFile}, ${reservationId}::uuid,
            ${pendingUntil}::timestamptz, now()
          FROM counted
          ON CONFLICT (clerk_user_id, object_key) DO UPDATE SET
            bytes = EXCLUDED.bytes, counts_as_file = EXCLUDED.counts_as_file,
            reservation_id = EXCLUDED.reservation_id, pending_until = EXCLUDED.pending_until, updated_at = now()
          RETURNING 1
        )
        SELECT prior_existed FROM counted
      `.execute(trx.executor);
      if (authorized.rows.length > 0) return { ok: true, reservationId };
      const prior = await trx.executor.selectFrom('runtime_storage_objects').select(['bytes', 'counts_as_file'])
        .where('clerk_user_id', '=', ownerId).where('object_key', '=', write.key).executeTakeFirst();
      const byteDelta = write.bytes - Number(prior?.bytes ?? 0);
      const code: StorageQuotaRefusal = byteDelta > 0 && usage.bytes + byteDelta > limits.maxBytes
        ? 'storage_full' : 'file_limit_reached';
      return { ok: false, code, priorExisted: Boolean(prior) };
    });
  }

  async function settle(ownerId: string, key: string, reservationId: string, landed: number | null): Promise<void> {
    await db.transaction(async (trx) => {
      await lockUsage(trx.executor, ownerId);
      const row = await trx.executor.selectFrom('runtime_storage_objects').select(['bytes', 'counts_as_file'])
        .where('clerk_user_id', '=', ownerId).where('object_key', '=', key)
        .where('reservation_id', '=', reservationId).executeTakeFirst();
      if (!row) return;
      const held = Number(row.bytes);
      if (landed === null) {
        await trx.executor.deleteFrom('runtime_storage_objects')
          .where('clerk_user_id', '=', ownerId).where('object_key', '=', key).execute();
      } else {
        await trx.executor.updateTable('runtime_storage_objects').set({ bytes: landed, pending_until: null, updated_at: now() })
          .where('clerk_user_id', '=', ownerId).where('object_key', '=', key).execute();
      }
      await trx.executor.updateTable('runtime_storage_usage').set({
        object_bytes: sql<number>`object_bytes + ${(landed ?? 0) - held}`,
        object_count: sql<number>`object_count - ${landed === null && row.counts_as_file ? 1 : 0}`,
        updated_at: now(),
      }).where('clerk_user_id', '=', ownerId).execute();
    });
  }

  /** Settles a bounded batch of expired pending writes against the store; returns how many it settled. */
  async function reconcile(ownerId: string): Promise<number> {
    const expired = await db.executor.selectFrom('runtime_storage_objects').select(['object_key', 'reservation_id'])
      .where('clerk_user_id', '=', ownerId).where('pending_until', 'is not', null)
      .where('pending_until', '<', now()).orderBy('pending_until').limit(RECONCILE_BATCH).execute();
    let settled = 0;
    const budget = AbortSignal.timeout(RECONCILE_BUDGET_MS);
    for (const row of expired) {
      if (budget.aborted) break;
      try {
        const head = await deps.headObject(row.object_key, {
          signal: AbortSignal.any([budget, AbortSignal.timeout(HEAD_TIMEOUT_MS)]),
        });
        if (head.exists && (head.contentLength === undefined || !Number.isSafeInteger(head.contentLength))) continue;
        await settle(ownerId, row.object_key, row.reservation_id, head.exists ? head.contentLength! : null);
        settled += 1;
      } catch (error: unknown) {
        logError('[storage-quota] reconcile probe failed', { cause: error instanceof Error ? error.name : 'unknown' });
      }
    }
    return settled;
  }

  return {
    limits,

    /** Authorizes and records a write; one reconcile pass runs before a refusal is final. */
    async authorize(ownerId: string, write: StorageWrite): Promise<StorageQuotaDecision> {
      assertWrite(write);
      const first = await tryAuthorize(ownerId, write);
      if (first.ok || await reconcile(ownerId) === 0) return first;
      return tryAuthorize(ownerId, write);
    },

    /** Marks a pending write as landed. A newer authorization of the same key keeps its own state. */
    async confirm(ownerId: string, key: string, reservationId: string): Promise<void> {
      await db.executor.updateTable('runtime_storage_objects').set({ pending_until: null, updated_at: now() })
        .where('clerk_user_id', '=', ownerId).where('object_key', '=', key)
        .where('reservation_id', '=', reservationId).execute();
    },

    /** Releases a deleted key. Deleting is never refused. */
    async release(ownerId: string, key: string): Promise<void> {
      await db.transaction(async (trx) => {
        await lockUsage(trx.executor, ownerId);
        await sql`
          WITH gone AS (
            DELETE FROM runtime_storage_objects WHERE clerk_user_id = ${ownerId} AND object_key = ${key}
            RETURNING bytes, counts_as_file
          )
          UPDATE runtime_storage_usage u
          SET object_bytes = u.object_bytes - g.bytes,
            object_count = u.object_count - (CASE WHEN g.counts_as_file THEN 1 ELSE 0 END),
            updated_at = now()
          FROM gone g WHERE u.clerk_user_id = ${ownerId}
        `.execute(trx.executor);
      });
    },

    reconcile,
  };
}

export type StorageQuota = ReturnType<typeof createStorageQuota>;
