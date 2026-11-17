import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';

/** Opt-in disposable loopback Postgres; never a remote URL. */
export const freeTierPostgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;

export interface ScopedPlatformDbs {
  pools: PlatformDB[];
  close(): Promise<void>;
}

/**
 * Independent platform pools on one fresh schema, so races cross real
 * connections. A pool that fails to become ready releases everything opened
 * so far, and closing always ends the admin pool.
 */
export async function createScopedPlatformDbs(
  label: string,
  count: number,
  createDb: (url: string) => PlatformDB = createPlatformDb,
): Promise<ScopedPlatformDbs> {
  const parsed = new URL(freeTierPostgresUrl!);
  if (!['127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
    throw new Error('Disposable literal-loopback _test database required');
  }
  const schema = `${label}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: freeTierPostgresUrl, max: 1 });
  const pools: PlatformDB[] = [];
  const release = async () => {
    try {
      for (const db of pools) {
        await db.destroy().catch((error: unknown) => {
          console.error('[free-tier-postgres-helper] pool close failed', error instanceof Error ? error.name : 'unknown');
        });
      }
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (let index = 0; index < count; index += 1) {
      const scoped = new URL(freeTierPostgresUrl!);
      scoped.searchParams.set('options', `-c search_path=${schema} -c lock_timeout=5000 -c statement_timeout=10000`);
      scoped.searchParams.set('application_name', `${label}-${index}`);
      const db = createDb(scoped.toString());
      pools.push(db);
      await db.ready;
    }
  } catch (error: unknown) {
    await release();
    throw error;
  }
  return { pools, close: release };
}
