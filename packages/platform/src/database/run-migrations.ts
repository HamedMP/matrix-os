import { migrateNativeLive } from '../native-live/migration.js';
import { NATIVE_LIVE_SCHEMA_REVISION } from '../native-live/migration-revision.js';
import type { Kysely } from 'kysely';
import type { PlatformDatabase } from '../db.js';
import { runPlatformMigration } from '../migration-runner.js';
import { PLATFORM_SCHEMA_REVISION } from './migration-revision.js';
import { migratePlatformSchema } from './migrate.js';
import { migrateWhatsApp } from './migrations/whatsapp.js';
import { WHATSAPP_SCHEMA_REVISION } from './whatsapp-migration-revision.js';

export async function runPlatformStartupMigrations(db: Kysely<PlatformDatabase>): Promise<void> {
  await runPlatformMigration(db, migratePlatformSchema, {
    revision: PLATFORM_SCHEMA_REVISION, deadlockAttempts: 12,
  });
  await runPlatformMigration(db, migrateNativeLive, {
    scope: 'native-live', revision: NATIVE_LIVE_SCHEMA_REVISION, deadlockAttempts: 12,
  });
  // A preview may have recorded a newer core generation without this channel.
  // Keep its core marker intact while independently ensuring our channel schema.
  await runPlatformMigration(db, migrateWhatsApp, {
    scope: 'whatsapp', revision: WHATSAPP_SCHEMA_REVISION, deadlockAttempts: 12,
  });
}
