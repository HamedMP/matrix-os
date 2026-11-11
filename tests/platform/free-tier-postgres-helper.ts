import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';

/** Opt-in disposable loopback Postgres; never a remote URL. */
export const freeTierPostgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;

export interface ScopedPlatformDbs {
  pools: PlatformDB[];
  close(): Promise<void>;
}

/** Independent platform pools on one fresh schema, so races cross real connections. */
export async function createScopedPlatformDbs(label: string, count: number): Promise<ScopedPlatformDbs> {
  const parsed = new URL(freeTierPostgresUrl!);
  if (!['127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
    throw new Error('Disposable literal-loopback _test database required');
  }
  const schema = `${label}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: freeTierPostgresUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pools: PlatformDB[] = [];
  for (let index = 0; index < count; index += 1) {
    const scoped = new URL(freeTierPostgresUrl!);
    scoped.searchParams.set('options', `-c search_path=${schema} -c lock_timeout=5000 -c statement_timeout=10000`);
    scoped.searchParams.set('application_name', `${label}-${index}`);
    const db = createPlatformDb(scoped.toString());
    await db.ready;
    pools.push(db);
  }
  return {
    pools,
    async close() {
      for (const db of pools) await db.destroy();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
