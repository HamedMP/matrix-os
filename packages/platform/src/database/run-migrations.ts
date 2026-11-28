import { migratePreviewPairPublisher } from "../preview-pair/migration.js";
import { GOOGLE_TRACKING_REVISION } from '../billing/google-tracking-revision.js';
import { migrateGooglePurchases } from '../billing/google-tracking-migration.js';
import type { Kysely } from 'kysely';
import { migrateSites, SITES_SCHEMA_REVISION } from '../sites/migration.js';
import type { PlatformDatabase } from '../db.js';
import { runPlatformMigration } from '../migration-runner.js';
import { PLATFORM_SCHEMA_REVISION } from './migration-revision.js';
import { assertFundedConservativeFence, migrateFundedConservativeFence, FUNDED_CONSERVATIVE_FENCE_SCOPE } from "./funded-conservative-fence.js";
import { FUNDED_CONSERVATIVE_FENCE_REVISION } from "./funded-conservative-fence-revision.js";
import { migratePlatformSchema } from './migrate.js';
import { migrateFundedProbeCache } from "./funded-probe-cache-migration.js";
import { FUNDED_PROBE_CACHE_REVISION } from "./funded-probe-cache-revision.js";
import { migrateAiFundedPricing } from './funded-pricing-review-migration.js';
import { FUNDED_PRICING_REVIEW_REVISION } from './funded-pricing-review-revision.js';
import { migrateWhatsApp } from './migrations/whatsapp.js';
import { WHATSAPP_SCHEMA_REVISION } from './whatsapp-migration-revision.js';
import { migrateManagedTerminalGrants, MANAGED_TERMINAL_GRANT_REVISION } from './managed-terminal-grant-migration.js';

function runManagedTerminalGrantMigration(db: Kysely<PlatformDatabase>): Promise<void> {
  return runPlatformMigration(db, migrateManagedTerminalGrants, {
    scope: 'managed-terminal-grants', revision: MANAGED_TERMINAL_GRANT_REVISION, deadlockAttempts: 12,
  });
}

export async function runPlatformStartupMigrations(
  db: Kysely<PlatformDatabase>,
  scope: 'all' | 'managed-terminal-grants' = 'all',
): Promise<void> {
  if (scope === 'managed-terminal-grants') return runManagedTerminalGrantMigration(db);
  await runPlatformMigration(db, migratePlatformSchema, {
    revision: PLATFORM_SCHEMA_REVISION, deadlockAttempts: 12,
  });
  await runPlatformMigration(db, migrateFundedConservativeFence, {
    scope: FUNDED_CONSERVATIVE_FENCE_SCOPE, revision: FUNDED_CONSERVATIVE_FENCE_REVISION, deadlockAttempts: 12,
  });
  // Always inspect the actual binding/body, including when its marker skips DDL.
  await assertFundedConservativeFence(db);
  await runPlatformMigration(db, migrateAiFundedPricing, {
    scope: 'funded-pricing-review', revision: FUNDED_PRICING_REVIEW_REVISION, deadlockAttempts: 12,
  });
  await runPlatformMigration(db, migrateFundedProbeCache, {
    scope: 'funded-probe-cache', revision: FUNDED_PROBE_CACHE_REVISION, deadlockAttempts: 12,
  });
  await runPlatformMigration(db, migrateGooglePurchases, { scope: 'billing-google-purchases', revision: GOOGLE_TRACKING_REVISION, deadlockAttempts: 12 });
  await runPlatformMigration(db, migrateSites, {
    scope: 'sites', revision: SITES_SCHEMA_REVISION, deadlockAttempts: 12,
  });
  await runPlatformMigration(db, migratePreviewPairPublisher, {
    scope: 'preview-pairs', revision: { generation: 5, fingerprint: 'collaboration-preview-pair-publisher-v5' }, deadlockAttempts: 12,
  });
  // A preview may have recorded a newer core generation without this channel.
  // Keep its core marker intact while independently ensuring our channel schema.
  await runPlatformMigration(db, migrateWhatsApp, {
    scope: 'whatsapp', revision: WHATSAPP_SCHEMA_REVISION, deadlockAttempts: 12,
  });
  await runManagedTerminalGrantMigration(db);
}
