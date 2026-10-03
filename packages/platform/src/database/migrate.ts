import type { PlatformMigrationExecutor } from './migration-types.js';
import { migrateIdentity } from './migrations/identity.js';
import { migrateUserMachines } from './migrations/user-machines.js';
import { migrateAiFunded } from './migrations/ai-funded.js';
import { migrateSpeech } from './migrations/speech.js';
import { migrateProvisioningJobs } from './migrations/provisioning-jobs.js';
import { migrateCheckout } from './migrations/checkout.js';
import { migrateOnboarding } from './migrations/onboarding.js';
import { migrateBilling } from './migrations/billing.js';
import { migrateHostBundles } from './migrations/host-bundles.js';
import { migrateGoldenSnapshots } from './migrations/golden-snapshots.js';
import { migrateProviderDeletion } from './migrations/provider-deletion.js';
import { migrateDirectoryAndSocial } from './migrations/directory-and-social.js';

export interface PlatformMigrationStep {
  readonly name: string;
  readonly run: (db: PlatformMigrationExecutor) => Promise<void>;
}

/**
 * Ordered platform schema registration. The steps run sequentially inside the
 * single advisory-locked transaction that migration-runner.ts opens; the order
 * is the original db.ts migrateSchema order and must not be reordered because
 * later steps ALTER tables created by earlier ones.
 */
export const PLATFORM_MIGRATION_STEPS: readonly PlatformMigrationStep[] = [
  { name: 'identity', run: migrateIdentity },
  { name: 'user-machines', run: migrateUserMachines },
  { name: 'ai-funded', run: migrateAiFunded },
  { name: 'speech', run: migrateSpeech },
  { name: 'provisioning-jobs', run: migrateProvisioningJobs },
  { name: 'checkout', run: migrateCheckout },
  { name: 'onboarding', run: migrateOnboarding },
  { name: 'billing', run: migrateBilling },
  { name: 'host-bundles', run: migrateHostBundles },
  { name: 'golden-snapshots', run: migrateGoldenSnapshots },
  { name: 'provider-deletion', run: migrateProviderDeletion },
  { name: 'directory-and-social', run: migrateDirectoryAndSocial },
];

export async function migratePlatformSchema(db: PlatformMigrationExecutor): Promise<void> {
  for (const step of PLATFORM_MIGRATION_STEPS) {
    await step.run(db);
  }
}

export type { PlatformMigrationExecutor } from './migration-types.js';
