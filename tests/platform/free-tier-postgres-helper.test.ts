import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import { createScopedPlatformDbs, freeTierPostgresUrl } from './free-tier-postgres-helper.js';

async function schemasNamed(prefix: string): Promise<number> {
  const admin = new pg.Client({ connectionString: freeTierPostgresUrl });
  await admin.connect();
  try {
    const result = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE $1', [`${prefix}\\_%`]);
    return result.rows[0]!.n;
  } finally {
    await admin.end();
  }
}

describe.skipIf(!freeTierPostgresUrl)('scoped platform pools for free-tier Postgres tests', () => {
  it('releases every pool and drops the schema when a pool fails to become ready', async () => {
    const destroyed: string[] = [];
    let created = 0;
    const createDb = (url: string): PlatformDB => {
      created += 1;
      const db = createPlatformDb(url);
      const index = created;
      const failing = index === 2;
      return {
        ...db,
        ready: failing ? db.ready.then(() => { throw new Error('migration failed'); }) : db.ready,
        destroy: async () => { destroyed.push(`pool-${index}`); await db.destroy(); },
      };
    };
    await expect(createScopedPlatformDbs('helperfail', 3, createDb)).rejects.toThrow('migration failed');
    expect(destroyed.sort()).toEqual(['pool-1', 'pool-2']);
    expect(await schemasNamed('helperfail')).toBe(0);
  });
});
