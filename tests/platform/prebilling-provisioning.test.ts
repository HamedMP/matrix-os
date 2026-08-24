import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimCheckoutAttempt,
  getActiveUserMachineByClerkId,
  insertUserMachine,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  loadPrebillingProvisioningConfig,
  prebillingRolloutIncludesUser,
} from '../../packages/platform/src/prebilling-provisioning-config.js';
import {
  admitPrebillingIntent,
  createPrebillingIntent,
  getPrebillingIntentByCheckoutAttempt,
} from '../../packages/platform/src/prebilling-provisioning-store.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { listProvisioningJobs } from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const CREATED_AT = '2026-08-24T10:00:00.000Z';
const EXPIRES_AT = '2026-08-24T10:30:00.000Z';

describe('platform prebilling provisioning foundation', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('is disabled by default and parses bounded rollout and capacity settings', () => {
    const defaults = loadPrebillingProvisioningConfig({});
    expect(defaults).toMatchObject({
      enabled: false,
      rolloutPercent: 0,
      maxActive: 0,
      maxHourlyCostMicros: 0,
      leaseMs: 30 * 60 * 1_000,
    });
    expect(prebillingRolloutIncludesUser(defaults, 'user_123')).toBe(false);

    const enabled = loadPrebillingProvisioningConfig({
      MATRIX_PREBILLING_PROVISIONING_ENABLED: 'true',
      MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT: '100',
      MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: '2',
      MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS: '250000',
      MATRIX_PREBILLING_PROVISIONING_COSTS_JSON: '{"cpx22":50000}',
    });
    expect(enabled.serverHourlyCostMicros.get('cpx22')).toBe(50_000);
    expect(prebillingRolloutIncludesUser(enabled, 'user_123')).toBe(true);
  });

  it('creates one immutable intent for a checkout and canonical selection', async () => {
    await seedCheckout('checkout-1', 'user_123');

    const first = await createPrebillingIntent(db, {
      id: 'intent-1',
      checkoutAttemptId: 'checkout-1',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      serverType: 'cpx32',
      regionSlug: 'region_fsn1',
      developerTools: ['codex', 'claude-code'],
      createdAt: CREATED_AT,
    });
    const repeated = await createPrebillingIntent(db, {
      id: 'intent-retry',
      checkoutAttemptId: 'checkout-1',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      serverType: 'cpx32',
      regionSlug: 'region_fsn1',
      developerTools: ['codex', 'claude-code'],
      createdAt: CREATED_AT,
    });

    expect(first.created).toBe(true);
    expect(repeated).toMatchObject({ created: false, selectionMatches: true });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      id: 'intent-1',
      state: 'awaiting_checkout',
      developerTools: ['codex', 'claude-code'],
      revision: 1,
    });
  });

  it('admits within global count and cost ceilings and defers without reserving when full', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await seedCheckout('checkout-2', 'user_456');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    await createIntent('intent-2', 'checkout-2', 'user_456');

    const admitted = await admitPrebillingIntent(db, {
      intentId: 'intent-1',
      stripeSessionId: 'cs_1',
      stripeSessionExpiresAt: EXPIRES_AT,
      reservedHourlyCostMicros: 50_000,
      maxActive: 1,
      maxHourlyCostMicros: 50_000,
      now: CREATED_AT,
    });
    const deferred = await admitPrebillingIntent(db, {
      intentId: 'intent-2',
      stripeSessionId: 'cs_2',
      stripeSessionExpiresAt: EXPIRES_AT,
      reservedHourlyCostMicros: 50_000,
      maxActive: 1,
      maxHourlyCostMicros: 50_000,
      now: CREATED_AT,
    });

    expect(admitted).toMatchObject({ admitted: true, reason: 'admitted' });
    expect(admitted.intent).toMatchObject({ state: 'preparing', reservedHourlyCostMicros: 50_000 });
    expect(deferred).toMatchObject({ admitted: false, reason: 'capacity' });
    expect(deferred.intent).toMatchObject({ state: 'preparation_deferred', reservedHourlyCostMicros: 0 });
  });

  it('keeps existing machines authorized by default during the additive migration', async () => {
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'user_existing',
      handle: 'existing-user',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      accessClerkUserIds: [],
      status: 'running',
      imageVersion: 'dev',
      developerTools: ['codex'],
      registrationTokenHash: null,
      registrationTokenExpiresAt: null,
      provisionedAt: CREATED_AT,
    });

    await expect(getActiveUserMachineByClerkId(db, 'user_existing', 'primary')).resolves.toMatchObject({
      activationState: 'authorized',
      prebillingIntentId: null,
    });
  });

  it('creates a fenced awaiting-billing machine without an entitlement only for an admitted intent', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    await admitPrebillingIntent(db, {
      intentId: 'intent-1',
      stripeSessionId: 'cs_1',
      stripeSessionExpiresAt: EXPIRES_AT,
      reservedHourlyCostMicros: 50_000,
      maxActive: 1,
      maxHourlyCostMicros: 50_000,
      now: CREATED_AT,
    });
    const hetzner = createMockHetznerClient();
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret',
        HETZNER_API_TOKEN: 'provider-token',
        S3_ACCESS_KEY_ID: 'r2-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-secret-key',
        S3_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'matrixos-sync',
      }),
      hetzner,
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      provisioningJobIdFactory: () => '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
      tokenFactory: () => ({
        token: 'registration-token',
        hash: hashRegistrationToken('registration-token'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      postgresPasswordFactory: () => 'postgres-secret',
      now: () => new Date(CREATED_AT),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(null),
    });
    const request = {
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary' as const,
      serverType: 'cpx32',
      location: 'fsn1' as const,
      developerTools: ['codex', 'claude-code'] as const,
    };

    await expect(service.provision(request)).rejects.toMatchObject({ code: 'billing_required' });
    await expect(service.provisionForCheckout(request, 'intent-1')).resolves.toMatchObject({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'provisioning',
    });

    expect(hetzner.createServer).toHaveBeenCalledOnce();
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toMatchObject({
      activationState: 'awaiting_billing',
      prebillingIntentId: 'intent-1',
    });
    await expect(listProvisioningJobs(db, 10)).resolves.toEqual([
      expect.objectContaining({
        authorizationBasis: 'prebilling_intent',
        prebillingIntentId: 'intent-1',
      }),
    ]);
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
    });
  });

  async function seedCheckout(id: string, clerkUserId: string): Promise<void> {
    const claimed = await claimCheckoutAttempt(db, {
      id,
      clerkUserId,
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      regionSlug: 'region_fsn1',
      serverType: 'cpx32',
      developerTools: ['codex', 'claude-code'],
      createdAt: CREATED_AT,
    });
    expect(claimed.claimed).toBe(true);
  }

  async function createIntent(id: string, checkoutAttemptId: string, clerkUserId: string): Promise<void> {
    await createPrebillingIntent(db, {
      id,
      checkoutAttemptId,
      clerkUserId,
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      serverType: 'cpx32',
      regionSlug: 'region_fsn1',
      developerTools: ['codex', 'claude-code'],
      createdAt: CREATED_AT,
    });
  }
});
