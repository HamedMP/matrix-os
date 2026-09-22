import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as dbModule from '../../packages/platform/src/db.js';
import {
  PLATFORM_MIGRATION_STEPS,
  migratePlatformSchema,
} from '../../packages/platform/src/database/migrate.js';
import * as userMachineRecords from '../../packages/platform/src/database/user-machine-records.js';
import * as userMachines from '../../packages/platform/src/database/user-machines.js';
import * as userMachineLifecycle from '../../packages/platform/src/database/user-machine-lifecycle.js';
import * as hostBundles from '../../packages/platform/src/database/host-bundles.js';
import * as billingQueries from '../../packages/platform/src/database/billing.js';
import * as billingEntitlements from '../../packages/platform/src/database/billing-entitlements.js';
import * as checkoutAttempts from '../../packages/platform/src/database/checkout-attempts.js';
import * as billingRoutes from '../../packages/platform/src/billing-routes.js';
import * as webhookProjection from '../../packages/platform/src/billing/stripe-webhook-projection.js';
import * as checkoutSupport from '../../packages/platform/src/billing/checkout-support.js';
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from './platform-db-test-helper.js';

/**
 * S01 / T006 characterization: the platform schema registration and the
 * customer-VPS (user machine) query seams keep their observable behavior after
 * extraction out of packages/platform/src/db.ts. The baseline fixture (tables,
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
      'speech',
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

describe('platform db.ts export compatibility (S01 foundation)', () => {
  it('re-exports the user machine queries from the focused modules by identity', () => {
    const machineExports = [
      'insertUserMachine', 'getUserMachine', 'getActiveUserMachineByClerkId', 'accessibleUserMachinePredicate',
      'getAccessibleActiveUserMachineByClerkId', 'getActiveUserMachineByHandle', 'getRunningUserMachineByHandle',
      'getRunningUserMachineByClerkId', 'getAccessibleRunningUserMachineByClerkId',
      'getRunningUserMachineByClerkIdForUpdate', 'listUserMachines', 'listActiveUserMachinesByClerkId',
      'listAccessibleActiveUserMachinesByClerkId', 'listNonDeletedUserMachinesByClerkId', 'updateUserMachine',
      'listRunningUserMachines', 'listAllUserMachines', 'listStaleUserMachines', 'lockUserMachineProvisioning',
    ] as const;
    for (const name of machineExports) {
      expect(dbModule[name], name).toBe(userMachines[name]);
    }
    for (const name of ['UserMachineProvisioningClassSchema', 'parseNullableProviderActionId'] as const) {
      expect(dbModule[name], name).toBe(userMachineRecords[name]);
    }
    const lifecycleExports = [
      'claimRunningUserMachineResize', 'completeUserMachineResize', 'claimRunningUserMachineBillingSuspend',
      'completeUserMachineBillingSuspend', 'claimSuspendedUserMachineBillingResume', 'completeUserMachineBillingResume',
      'listStaleResizingUserMachines', 'completeUserMachineRegistration', 'claimUserMachineRecovery',
      'retireUserMachine', 'claimUserMachineDelete', 'softDeleteUserMachine', 'insertProviderDeletion',
      'listPendingProviderDeletions', 'markProviderDeletionCompleted', 'markProviderDeletionFailed',
    ] as const;
    for (const name of lifecycleExports) {
      expect(dbModule[name], name).toBe(userMachineLifecycle[name]);
    }
    const bundleExports = [
      'upsertHostBundleRelease', 'getHostBundleRelease', 'listHostBundleReleases', 'promoteHostBundleChannel',
      'promoteHostBundleChannelInTransaction', 'registerHostBundleRelease', 'getHostBundleChannel',
      'getHostBundleReleaseByChannel', 'HostBundleReleaseConflictError',
    ] as const;
    for (const name of bundleExports) {
      expect(dbModule[name], name).toBe(hostBundles[name]);
    }
  });

  it('keeps the composition entrypoints on db.ts', () => {
    expect(typeof dbModule.createPlatformDb).toBe('function');
    expect(typeof dbModule.getDb).toBe('function');
    expect(typeof dbModule.resetDb).toBe('function');
    expect(typeof dbModule.runInPlatformTransaction).toBe('function');
  });
});

describe('user machine seam behavior (S01 foundation)', () => {
  let fixture: TestPlatformDb;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
  });

  afterEach(async () => {
    await destroyTestPlatformDb(fixture.db);
  });

  it('round-trips a machine through the extracted module and the legacy entrypoint identically', async () => {
    const now = new Date('2026-09-20T12:00:00.000Z').toISOString();
    await userMachines.insertUserMachine(fixture.db, {
      machineId: 'machine_1',
      clerkUserId: 'user_1',
      handle: 'alice',
      status: 'running',
      provisionedAt: now,
    });
    const viaModule = await userMachines.getUserMachine(fixture.db, 'machine_1');
    const viaLegacy = await dbModule.getUserMachine(fixture.db, 'machine_1');
    expect(viaModule).not.toBeNull();
    expect(viaLegacy).toEqual(viaModule);
    expect(await dbModule.getActiveUserMachineByHandle(fixture.db, 'alice')).toEqual(viaModule);
  });
});

describe('personal billing seams (S01 foundation)', () => {
  it('re-exports the billing queries from the focused modules by identity', () => {
    const subscriptionExports = [
      'upsertBillingCustomer', 'insertBillingCustomerIfAbsent', 'getBillingCustomerByClerkUserId',
      'getBillingCustomerByStripeCustomerId', 'hasBillingSubscriptionHistory', 'upsertBillingSubscription',
      'persistBillingSubscriptionPriceSnapshot', 'getBillingSubscription', 'getBillingSubscriptionByStripeId',
      'projectTrialInvoiceEvent', 'listCurrentBillingSubscriptions',
    ] as const;
    for (const name of subscriptionExports) {
      expect(dbModule[name], name).toBe(billingQueries[name]);
    }
    const entitlementExports = [
      'upsertBillingEntitlement', 'getBillingEntitlement', 'upsertBillingOverride', 'getBillingOverride',
      'getBillingEntitlementState', 'revokeBillingOverride', 'insertBillingWebhookEvent', 'getBillingWebhookEvent',
    ] as const;
    for (const name of entitlementExports) {
      expect(dbModule[name], name).toBe(billingEntitlements[name]);
    }
    const checkoutExports = [
      'insertCheckoutAttempt', 'claimCheckoutAttempt', 'claimCardTrialCheckoutAttempt', 'isCardTrialOfferEligible',
      'consumeCardTrial', 'finalizeCheckoutAttempt', 'abandonCreatingCheckoutAttempt', 'getLatestCheckoutAttempt',
      'getActiveCheckoutAttempt', 'getSettlingCheckoutAttempt', 'resolveCheckoutAttempt', 'sweepStaleCheckoutAttempts',
    ] as const;
    for (const name of checkoutExports) {
      expect(dbModule[name], name).toBe(checkoutAttempts[name]);
    }
  });

  it('keeps the billing route entrypoints and moves the Stripe helpers behind them', () => {
    expect(typeof billingRoutes.createBillingRoutes).toBe('function');
    expect(typeof billingRoutes.getPublicBillingPlans).toBe('function');
    expect(billingRoutes.MATRIX_CARD_TRIAL_DAYS).toBe(3);
    expect(webhookProjection.normalizeSubscriptionStatus('trialing')).toBe('trialing');
    expect(webhookProjection.normalizeSubscriptionStatus('paused')).toBe('ended');
    expect(webhookProjection.epochSecondsToIso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(webhookProjection.isSubscriptionEvent('customer.subscription.trial_will_end')).toBe(true);
    expect(webhookProjection.isSubscriptionEvent('invoice.paid')).toBe(false);
    expect(webhookProjection.readClerkUserIdFromStripeMetadata({ clerk_user_id: 'user_abc123' })).toBe('user_abc123');
    expect(webhookProjection.readClerkUserIdFromStripeMetadata({ clerk_user_id: 'nope' })).toBeNull();
    expect(webhookProjection.readInvoiceProjection({
      created: 1_700_000_000,
      billing_reason: 'subscription_cycle',
      amount_due: 1000,
      amount_paid: 1000,
      currency: 'usd',
      subscription: 'sub_1',
    })).toEqual({
      stripeSubscriptionId: 'sub_1',
      billingReason: 'subscription_cycle',
      createdAt: '2023-11-14T22:13:20.000Z',
      amountDueMinor: 1000,
      amountPaidMinor: 1000,
      currency: 'usd',
    });
    expect(webhookProjection.readInvoiceProjection({ created: 1, billing_reason: 'x' })).toBeNull();
    expect(webhookProjection.isFirstPostTrialInvoice(
      { stripeSubscriptionId: 'sub_1', billingReason: 'subscription_cycle', createdAt: '2026-02-01T00:00:00.000Z',
        amountDueMinor: 1, amountPaidMinor: 1, currency: 'usd' },
      '2026-01-31T00:00:00.000Z',
      null,
    )).toBe(true);
    expect(checkoutSupport.resolveBillingReturnUrl({ MATRIX_APP_ORIGIN: 'https://app.example.test' } as NodeJS.ProcessEnv, 'success'))
      .toBe('https://app.example.test/?billing=success&checkout=success');
    // Off-allowlist return paths collapse to "/" through resolveReturnPath (guard preserved).
    expect(checkoutSupport.resolveBillingReturnUrl({ MATRIX_APP_ORIGIN: 'https://app.example.test' } as NodeJS.ProcessEnv, 'canceled', '/settings'))
      .toBe('https://app.example.test/?billing=canceled');
    expect(checkoutSupport.planPriceUsd('starter' as never, 'annual')).toBeUndefined();
  });
});
