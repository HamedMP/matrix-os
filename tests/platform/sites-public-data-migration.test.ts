import { describe, expect, it } from 'vitest';
import { Kysely, sql } from 'kysely';
import { KyselyPGlite } from 'kysely-pglite';
import type { PlatformDatabase } from '../../packages/platform/src/db.js';
import { runPlatformMigration } from '../../packages/platform/src/migration-runner.js';
import { runPlatformStartupMigrations } from '../../packages/platform/src/database/run-migrations.js';
import { migrateSites, SITES_SCHEMA_REVISION } from '../../packages/platform/src/sites/migration.js';
import { SITE_PUBLIC_DATA_REVISION } from '../../packages/platform/src/sites/public-data-migration.js';

describe('sites public data opt-in migration', () => {
  it('upgrades a generation 3 database without opting existing public links in', async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<PlatformDatabase>({ dialect: instance.dialect });
    try {
      await runPlatformStartupMigrations(db);
      // Model a deployment recorded at generation 3, before the opt-in column existed.
      await sql`ALTER TABLE public_sites DROP COLUMN public_data_enabled_at`.execute(db);
      await sql`DELETE FROM platform_schema_revisions WHERE scope = 'sites-public-data'`.execute(db);
      await sql`UPDATE platform_schema_revisions SET generation = 3, fingerprint = 'public-app-sites-email-invitations-v3' WHERE scope = 'sites'`.execute(db);
      await sql`INSERT INTO public_sites (id,owner_id,machine_id,app_slug,title,description,revision,status,access_mode,active_version,created_at)
        VALUES ('11111111-1111-4111-8111-111111111111','user_existing','machine-existing','launch','Launch','',3,'published','public',NULL,'2026-11-01')`.execute(db);
      await runPlatformStartupMigrations(db);
      expect((await sql<{ public_data_enabled_at: string | null }>`SELECT public_data_enabled_at FROM public_sites`.execute(db)).rows)
        .toEqual([{ public_data_enabled_at: null }]);
      expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'sites'`.execute(db)).rows)
        .toEqual([{ generation: SITES_SCHEMA_REVISION.generation, fingerprint: SITES_SCHEMA_REVISION.fingerprint }]);
      expect(SITES_SCHEMA_REVISION.generation).toBe(3);
      expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'sites-public-data'`.execute(db)).rows)
        .toEqual([SITE_PUBLIC_DATA_REVISION]);
      // Re-running is a no-op.
      await runPlatformMigration(db, migrateSites, { scope: 'sites', revision: SITES_SCHEMA_REVISION });
    } finally { await db.destroy(); }
  });
});
