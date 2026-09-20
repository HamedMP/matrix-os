import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateHostBundles(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS host_bundle_releases (
      version TEXT PRIMARY KEY,
      channel TEXT,
      git_commit TEXT NOT NULL,
      git_ref TEXT,
      snapshot_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      snapshot_eligibility_source TEXT NOT NULL DEFAULT 'legacy'
        CHECK (snapshot_eligibility_source IN ('legacy', 'explicit')),
      build_time TEXT NOT NULL,
      bundle_key TEXT NOT NULL,
      checksum_key TEXT,
      incremental_manifest_key TEXT,
      incremental_manifest_sha256 TEXT,
      sha256 TEXT NOT NULL,
      size BIGINT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'normal',
      update_type TEXT NOT NULL DEFAULT 'manual',
      changelog TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS channel TEXT`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS snapshot_eligible BOOLEAN NOT NULL DEFAULT FALSE`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS snapshot_eligibility_source TEXT NOT NULL DEFAULT 'legacy'`.execute(db);
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'host_bundle_releases'::regclass
          AND conname = 'host_bundle_releases_snapshot_eligibility_source_check'
      ) THEN
        ALTER TABLE host_bundle_releases
          ADD CONSTRAINT host_bundle_releases_snapshot_eligibility_source_check
          CHECK (snapshot_eligibility_source IN ('legacy', 'explicit'));
      END IF;
    END $$
  `.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS incremental_manifest_key TEXT`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS incremental_manifest_sha256 TEXT`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ALTER COLUMN size TYPE BIGINT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_releases_channel ON host_bundle_releases(channel)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_releases_created_at ON host_bundle_releases(created_at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS host_bundle_channels (
      channel TEXT PRIMARY KEY,
      version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_channels_version ON host_bundle_channels(version)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS host_bundle_release_channels (
      channel TEXT NOT NULL,
      version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      promoted_at TEXT NOT NULL,
      PRIMARY KEY (channel, version)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_release_channels_version ON host_bundle_release_channels(version)`.execute(db);
  await sql`
    INSERT INTO host_bundle_release_channels(channel, version, promoted_at)
    SELECT channel, version, created_at
    FROM host_bundle_releases
    WHERE channel IS NOT NULL
    ON CONFLICT (channel, version) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE host_bundle_releases AS release
    SET snapshot_eligible = TRUE
    WHERE release.snapshot_eligible = FALSE
      AND release.snapshot_eligibility_source = 'legacy'
      AND EXISTS (
        SELECT 1 FROM host_bundle_channels AS channel
        WHERE channel.version = release.version
          AND channel.channel IN ('dev', 'canary', 'beta', 'stable')
      )
  `.execute(db);
  await sql`
    INSERT INTO host_bundle_release_channels(channel, version, promoted_at)
    SELECT channel, version, updated_at
    FROM host_bundle_channels
    ON CONFLICT (channel, version) DO UPDATE SET promoted_at = EXCLUDED.promoted_at
  `.execute(db);
}
