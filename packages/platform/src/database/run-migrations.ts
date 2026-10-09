import { GOOGLE_TRACKING_REVISION } from '../billing/google-tracking-revision.js';
import { migrateGooglePurchases } from '../billing/google-tracking-migration.js';
import type { Kysely } from 'kysely';
import { migrateSites } from '../sites/migration.js';
import type { PlatformDatabase } from '../db.js';
import { runPlatformMigration } from '../migration-runner.js';
import { PLATFORM_SCHEMA_REVISION } from './migration-revision.js';
import { migratePlatformSchema } from './migrate.js';
import { migrateFundedProbeCache } from "./funded-probe-cache-migration.js";
import { FUNDED_PROBE_CACHE_REVISION } from "./funded-probe-cache-revision.js";
import { migrateWhatsApp } from './migrations/whatsapp.js';
import { WHATSAPP_SCHEMA_REVISION } from './whatsapp-migration-revision.js';

export async function runPlatformStartupMigrations(db: Kysely<PlatformDatabase>): Promise<void> {
  await runPlatformMigration(db, migratePlatformSchema, {
    revision: PLATFORM_SCHEMA_REVISION, deadlockAttempts: 12,
  });
  await runPlatformMigration(db, migrateFundedProbeCache, {
    scope: 'funded-probe-cache', revision: FUNDED_PROBE_CACHE_REVISION, deadlockAttempts: 12,
  });
  await runPlatformMigration(db, migrateGooglePurchases, { scope: 'billing-google-purchases', revision: GOOGLE_TRACKING_REVISION, deadlockAttempts: 12 });
  await runPlatformMigration(db, migrateSites, {
    scope: 'sites', revision: { generation: 1, fingerprint: 'public-app-sites-v1' }, deadlockAttempts: 12,
  });
  // A preview may have recorded a newer core generation without this channel.
  // Keep its core marker intact while independently ensuring our channel schema.
  await runPlatformMigration(db, migrateWhatsApp, {
    scope: 'whatsapp', revision: WHATSAPP_SCHEMA_REVISION, deadlockAttempts: 12,
  });
}
