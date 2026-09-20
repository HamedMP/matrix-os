import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as dbModule from '../../packages/platform/src/db.js';
import {
  PLATFORM_MIGRATION_STEPS,
  migratePlatformSchema,
} from '../../packages/platform/src/database/migrate.js';
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from './platform-db-test-helper.js';

/**
 * S01 / T006 characterization: the platform schema registration keeps its
 * observable behavior after extraction out of packages/platform/src/db.ts. The baseline fixture (tables,
 * columns, constraints and index definitions) was captured from the unextracted
 * migrateSchema at the 124/s00 base (8e44fe960) with the same queries used below.
 */
const { capturedFrom: _capturedFrom, ...baseline } = JSON.parse(
  readFileSync(new URL('./fixtures/platform-schema-baseline.json', import.meta.url), 'utf8'),
) as {
  capturedFrom: string;
  tables: string[];
  columns: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  indexes: Array<Record<string, unknown>>;
};
void _capturedFrom;

/** Full public schema shape: tables, columns, constraints (PK/unique/check/FK incl. references and ON DELETE) and index definitions. */
async function capturePublicSchema(db: dbModule.PlatformDB) {
  const x = db.executor;
  const tables = (await sql<{ table_name: string }>`
    select table_name from information_schema.tables where table_schema = 'public' order by table_name
  `.execute(x)).rows.map((r) => r.table_name);
  const columns = (await sql<Record<string, unknown>>`
    select table_name, column_name, data_type, is_nullable, column_default,
           character_maximum_length, numeric_precision, numeric_scale
    from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position
  `.execute(x)).rows;
  const constraints = (await sql<Record<string, unknown>>`
    select c.conrelid::regclass::text as table_name, c.conname as name, c.contype as type,
           pg_get_constraintdef(c.oid) as definition
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public' order by 1, 2
  `.execute(x)).rows;
  const indexes = (await sql<Record<string, unknown>>`
    select tablename as table_name, indexname as name, indexdef as definition
    from pg_indexes where schemaname = 'public' order by tablename, indexname
  `.execute(x)).rows;
  return { tables, columns, constraints, indexes };
}

describe('platform schema registration (S01 foundation)', () => {
  let fixture: TestPlatformDb;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
  });

  afterEach(async () => {
    await destroyTestPlatformDb(fixture.db);
  });

  it('registers the migration steps in the original db.ts order', () => {
    expect(PLATFORM_MIGRATION_STEPS.map((step) => step.name)).toEqual([
      'identity',
      'user-machines',
      'ai-funded',
      'provisioning-jobs',
      'checkout',
      'onboarding',
      'billing',
      'host-bundles',
      'golden-snapshots',
      'provider-deletion',
      'directory-and-social',
    ]);
    expect(PLATFORM_MIGRATION_STEPS.every((step) => typeof step.run === 'function')).toBe(true);
  });

  it('produces exactly the baseline tables, columns, constraints and index definitions', async () => {
    const actual = await capturePublicSchema(fixture.db);
    expect(actual.tables).toEqual(baseline.tables);
    expect(actual.columns).toEqual(baseline.columns);
    expect(actual.constraints).toEqual(baseline.constraints);
    expect(actual.indexes).toEqual(baseline.indexes);
  });

  it('re-runs idempotently through the extracted entrypoint', async () => {
    await migratePlatformSchema(fixture.db.executor);
    await migratePlatformSchema(fixture.db.executor);
    expect(await capturePublicSchema(fixture.db)).toEqual(baseline);
  });
});
