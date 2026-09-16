/**
 * Platform database entrypoint (Phase 1-A2).
 *
 * Connection lifecycle (pool, singleton, transactions) lives here.
 * Schema, migrations, and per-domain persistence moved to ./repositories/.
 * Everything previously imported from './db.js' is re-exported below, so
 * existing importers are untouched.
 */
import {
  Kysely,
  PostgresDialect,
  sql,
} from 'kysely';
import pg from 'pg';
import type { PlatformDatabase, PlatformDB } from './repositories/schema-tables.js';
import { migrate, wrapDb } from './repositories/migrate.js';

const DEFAULT_PLATFORM_DB_URL =
  process.env.PLATFORM_DATABASE_URL ??
  (process.env.POSTGRES_URL ? `${process.env.POSTGRES_URL}/matrixos_platform` : undefined);

export {
  cancelOutstandingBillingRuntimeActions,
  cancelQueuedBillingRuntimeActions,
  claimBillingRuntimeAction,
  completeBillingRuntimeAction,
  enqueueBillingRuntimeAction,
  finalizeBillingRuntimeAction,
  isBillingRuntimeActionRunnable,
  listBillingRuntimeActions,
  listDispatchableBillingRuntimeActions,
  listDispatchableBillingRuntimeActionsForMachine,
  retryBillingRuntimeAction,
} from './billing-runtime-action-store.js';
export type {
  BillingRuntimeAction,
  BillingRuntimeActionRecord,
  BillingRuntimeActionStatus,
} from './billing-runtime-action-store.js';

export * from './repositories/schema-tables.js';
export * from './repositories/schema-records.js';
export * from './repositories/users.js';
export * from './repositories/machines.js';
export * from './repositories/releases.js';
export * from './repositories/billing.js';
export * from './repositories/provisioning.js';
export * from './repositories/billing-checkout.js';
export * from './repositories/onboarding.js';

export function createPlatformDb(opts: string | { dialect: unknown } = DEFAULT_PLATFORM_DB_URL ?? ''): PlatformDB {
  if (typeof opts === 'string' && !opts) {
    throw new Error('Platform Postgres URL is required: set PLATFORM_DATABASE_URL or POSTGRES_URL');
  }

  let pool: pg.Pool | null = null;
  const kysely = typeof opts === 'string'
    ? (() => {
        pool = new pg.Pool({ connectionString: opts, max: 10 });
        pool.on('error', (err) => {
          console.error('[platform-db] Idle pool client error:', err.message);
        });
        return new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
      })()
    : new Kysely<PlatformDatabase>({ dialect: opts.dialect as never });

  const ready = migrate(kysely);
  return wrapDb(kysely, kysely, ready, async () => {
    await kysely.destroy();
    try {
      await pool?.end();
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === 'Called end on pool more than once')) {
        throw err;
      }
    }
  });
}

let singleton: PlatformDB | undefined;

export function getDb(dbUrl?: string): PlatformDB {
  if (!singleton) {
    singleton = createPlatformDb(dbUrl ?? DEFAULT_PLATFORM_DB_URL);
  }
  return singleton;
}

export async function resetDb(): Promise<void> {
  if (singleton) {
    await singleton.destroy();
    singleton = undefined;
  }
}

export async function runInPlatformTransaction<T>(
  db: PlatformDB,
  fn: (trx: PlatformDB) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

export async function runBillingWebhookTransaction<T>(
  db: PlatformDB,
  fn: (trx: PlatformDB) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

export async function lockUserMachineProvisioning(
  db: PlatformDB,
  clerkUserId: string,
): Promise<void> {
  await db.ready;
  await sql`
    SELECT pg_advisory_xact_lock(
      ('x' || substr(md5(${`user_machines:${clerkUserId}`}), 1, 16))::bit(64)::bigint
    )
  `.execute(db.executor);
}
