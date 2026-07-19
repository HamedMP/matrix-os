import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  AtsDatabaseConfigError,
  resolveAtsDatabaseUrl,
  type AtsDB,
} from '../../packages/platform/src/ats-db.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('ATS database isolation', () => {
  let atsDb: AtsDB | undefined;
  let platformDb: PlatformDB | undefined;

  afterEach(async () => {
    await Promise.all([destroyTestAtsDb(atsDb), destroyTestPlatformDb(platformDb)]);
    atsDb = undefined;
    platformDb = undefined;
  });

  it('migrates recruiting tables only in the dedicated ATS database', async () => {
    ({ db: atsDb } = await createTestAtsDb());
    ({ db: platformDb } = await createTestPlatformDb());

    const atsTable = await sql<{ name: string | null }>`SELECT to_regclass('ats_applications')::text AS name`.execute(atsDb.kysely);
    const platformTable = await sql<{ name: string | null }>`SELECT to_regclass('ats_applications')::text AS name`.execute(platformDb.kysely);

    expect(atsTable.rows[0]?.name).toBe('ats_applications');
    expect(platformTable.rows[0]?.name).toBeNull();
  });

  it('requires a dedicated database URL whenever ATS secrets enable recruiting', () => {
    expect(() => resolveAtsDatabaseUrl({ ATS_INGEST_SECRET: 'configured' })).toThrow(AtsDatabaseConfigError);
    expect(() => resolveAtsDatabaseUrl({ ATS_ADMIN_SECRET: 'configured' })).toThrow(AtsDatabaseConfigError);
    expect(resolveAtsDatabaseUrl({})).toBeUndefined();
    expect(resolveAtsDatabaseUrl({
      ATS_INGEST_SECRET: 'configured',
      ATS_DATABASE_URL: 'postgresql://ats.example/recruiting',
    })).toBe('postgresql://ats.example/recruiting');
  });
});
