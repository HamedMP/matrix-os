import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { migrateAppStore } from '../../packages/platform/src/app-store/migration.js';
import { APP_STORE_SCHEMA_REVISION } from '../../packages/platform/src/app-store/migration-revision.js';
import { PLATFORM_SCHEMA_REVISION } from '../../packages/platform/src/database/migration-revision.js';
let db: PlatformDB;
afterEach(async () => { await destroyTestPlatformDb(db); });
describe('independent App Store migration', () => {
  it('repeats idempotently and leaves the existing core revision intact', async () => {
    ({ db } = await createTestPlatformDb()); await migrateAppStore(db.executor); await migrateAppStore(db.executor);
    const revisions = await sql<{ scope: string; generation: number; fingerprint: string }>`SELECT scope,generation,fingerprint FROM platform_schema_revisions WHERE scope IN ('app-store','core')`.execute(db.executor);
    expect(revisions.rows.find(row => row.scope === 'core')).toMatchObject(PLATFORM_SCHEMA_REVISION);
    expect(revisions.rows.find(row => row.scope === 'app-store')).toMatchObject(APP_STORE_SCHEMA_REVISION);
    expect(createHash('sha256').update(readFileSync(new URL('../../packages/platform/src/app-store/migration.ts', import.meta.url))).digest('hex')).toBe(APP_STORE_SCHEMA_REVISION.fingerprint);
    const tables = await sql<{ name: string }>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'app_store_%'`.execute(db.executor);
    expect(tables.rows.map(row => row.name).sort()).toEqual(['app_store_installs','app_store_listings','app_store_moderation_events','app_store_ratings','app_store_versions']);
  });
});
