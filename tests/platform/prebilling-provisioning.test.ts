import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimCheckoutAttempt,
  getActiveUserMachineByClerkId,
  getAccessibleActiveUserMachineByClerkId,
  getRunningUserMachineByClerkId,
  insertUserMachine,
  updateUserMachine,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  loadPrebillingProvisioningConfig,
  prebillingRolloutIncludesUser,
} from '../../packages/platform/src/prebilling-provisioning-config.js';
import {
  admitPrebillingIntent,
  authorizePrebillingIntent,
  bindPrebillingIntentMachine,
  claimAuthorizedPrebillingFallbackIntent,
  createPrebillingIntent,
  cleanupExpiredPrebillingCheckout,
  getPrebillingIntentByCheckoutAttempt,
  listPaidPrebillingIntentsNeedingPreparation,
  markPrebillingPreparationFailed,
  markPrebillingIntentReady,
  resetPrebillingPreparationForRetry,
} from '../../packages/platform/src/prebilling-provisioning-store.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { createPrebillingProvisioningCoordinator } from '../../packages/platform/src/prebilling-provisioning.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { listProvisioningJobs } from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const CREATED_AT = '2026-08-24T10:00:00.000Z';
const EXPIRES_AT = '2026-08-24T10:31:00.000Z';

describe('platform prebilling provisioning foundation', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('is disabled by default and enables count-only capacity without legacy cost settings', () => {
    const defaults = loadPrebillingProvisioningConfig({});
    expect(defaults).toMatchObject({
      enabled: false,
      rolloutPercent: 0,
      maxActive: 0,
      leaseMs: 31 * 60 * 1_000,
    });
    expect(defaults).not.toHaveProperty('maxHourlyCostMicros');
    expect(defaults).not.toHaveProperty('serverHourlyCostMicros');
    expect(prebillingRolloutIncludesUser(defaults, 'user_123')).toBe(false);

    const enabled = loadPrebillingProvisioningConfig({
      MATRIX_PREBILLING_PROVISIONING_ENABLED: 'true',
      MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT: '100',
      MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: '4',
    });
    expect(enabled).toMatchObject({ enabled: true, rolloutPercent: 100, maxActive: 4 });
    expect(prebillingRolloutIncludesUser(enabled, 'user_123')).toBe(true);

    const legacyValuesAreIgnored = loadPrebillingProvisioningConfig({
      MATRIX_PREBILLING_PROVISIONING_ENABLED: 'true',
      MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT: '100',
      MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: '4',
      MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS: '1',
      MATRIX_PREBILLING_PROVISIONING_COSTS: 'cpx22:92900;cpx32:169900;cpx52:254000',
      MATRIX_PREBILLING_PROVISIONING_COSTS_JSON: '{"cpx22":999999999}',
    });
    expect(legacyValuesAreIgnored).toEqual(enabled);
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

  it('concurrently admits four mixed-size intents and defers exactly the fifth', async () => {
    const serverTypes = ['cpx22', 'cpx52', 'cpx32', 'cpx22', 'cpx52'];
    for (const index of [1, 2, 3, 4, 5]) {
      await seedCheckout(`checkout-${index}`, `user_${index}`, serverTypes[index - 1]);
      await createIntent(`intent-${index}`, `checkout-${index}`, `user_${index}`, serverTypes[index - 1]);
    }

    const admitted = await Promise.all([1, 2, 3, 4].map((index) => admitPrebillingIntent(db, {
      intentId: `intent-${index}`,
      stripeSessionId: `cs_${index}`,
      stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 4,
      now: CREATED_AT,
    })));
    const deferred = await admitPrebillingIntent(db, {
      intentId: 'intent-5',
      stripeSessionId: 'cs_5',
      stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 4,
      now: CREATED_AT,
    });

    expect(admitted).toHaveLength(4);
    expect(admitted.every((result) => result.admitted)).toBe(true);
    expect(admitted.every((result) => result.intent.state === 'preparing')).toBe(true);
    expect(deferred).toMatchObject({ admitted: false, reason: 'capacity' });
    expect(deferred.intent).toMatchObject({ state: 'preparation_deferred' });
    await expect(resetPrebillingPreparationForRetry(db, {
      intentId: 'intent-5',
      clerkUserId: 'user_5',
      now: CREATED_AT,
    })).resolves.toBe(true);
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-2')).resolves.toMatchObject({
      state: 'preparing',
    });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-5')).resolves.toMatchObject({
      state: 'awaiting_checkout',
      lastErrorCode: null,
    });
  });

  it('ignores old nonzero reservation rows when admitting by active count', async () => {
    await seedCheckout('checkout-1', 'user_123', 'cpx52');
    await seedCheckout('checkout-2', 'user_456', 'cpx22');
    await createIntent('intent-1', 'checkout-1', 'user_123', 'cpx52');
    await createIntent('intent-2', 'checkout-2', 'user_456', 'cpx22');

    await db.executor.updateTable('prebilling_provisioning_intents').set({
      state: 'preparing',
      stripe_session_id: 'cs_legacy',
      stripe_session_expires_at: EXPIRES_AT,
      lease_expires_at: EXPIRES_AT,
      reserved_hourly_cost_micros: 999_999_999,
    }).where('id', '=', 'intent-1').execute();

    const admitted = await admitPrebillingIntent(db, {
      intentId: 'intent-2',
      stripeSessionId: 'cs_2',
      stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 4,
      now: CREATED_AT,
    });

    expect(admitted).toMatchObject({ admitted: true, reason: 'admitted' });
    const row = await db.executor.selectFrom('prebilling_provisioning_intents')
      .select('reserved_hourly_cost_micros')
      .where('id', '=', 'intent-2')
      .executeTakeFirstOrThrow();
    expect(Number(row.reserved_hourly_cost_micros)).toBe(0);
  });

  it('does not admit an existing unpaid checkout intent after admission is disabled', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    const provisionForCheckout = vi.fn();
    const resolveIdentity = vi.fn().mockResolvedValue({ handle: 'alice' });
    const coordinator = createPrebillingProvisioningCoordinator({
      db,
      config: loadPrebillingProvisioningConfig({}),
      customerVpsService: { provisionForCheckout } as never,
      resolveIdentity,
      now: () => new Date(CREATED_AT),
    });

    await expect(coordinator.startPreparation({
      intentId: 'intent-1',
      stripeSessionId: 'cs_1',
      stripeSessionExpiresAt: EXPIRES_AT,
    })).resolves.toBe(false);

    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(provisionForCheckout).not.toHaveBeenCalled();
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'awaiting_checkout',
      stripeSessionId: null,
      leaseExpiresAt: null,
    });
  });

  it('does not reset and re-admit an unpaid failed preparation after admission is disabled', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    await admitPrebillingIntent(db, {
      intentId: 'intent-1', stripeSessionId: 'cs_1', stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1, now: CREATED_AT,
    });
    await markPrebillingPreparationFailed(db, {
      intentId: 'intent-1', now: CREATED_AT, errorCode: 'provider_timeout',
    });
    const provisionForCheckout = vi.fn();
    const coordinator = createPrebillingProvisioningCoordinator({
      db,
      config: loadPrebillingProvisioningConfig({}),
      customerVpsService: { provisionForCheckout } as never,
      resolveIdentity: vi.fn().mockResolvedValue({ handle: 'alice' }),
      now: () => new Date(CREATED_AT),
    });

    await expect(coordinator.retryPreparation({
      checkoutAttemptId: 'checkout-1', clerkUserId: 'user_123',
    })).resolves.toBe(false);

    expect(provisionForCheckout).not.toHaveBeenCalled();
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'preparation_failed',
      stripeSessionId: 'cs_1',
    });
  });

  it('resumes the same paid intent even when unpaid admission is disabled and capacity is full', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await seedCheckout('checkout-2', 'user_456');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    await createIntent('intent-2', 'checkout-2', 'user_456');
    await admitPrebillingIntent(db, {
      intentId: 'intent-1', stripeSessionId: 'cs_1', stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1, now: CREATED_AT,
    });
    await admitPrebillingIntent(db, {
      intentId: 'intent-2', stripeSessionId: 'cs_2', stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1, now: CREATED_AT,
    });
    await db.transaction((trx) => authorizePrebillingIntent(trx, {
      intentId: 'intent-2',
      clerkUserId: 'user_456',
      runtimeSlot: 'primary',
      now: '2026-08-24T10:01:00.000Z',
    }));

    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff456',
      '9f05824c-8d0a-4d83-9cb4-b312d43ff457',
    ];
    const provisioningJobIds = [
      '721c3ef8-23f6-47e4-a890-6f6dc1475456',
      '721c3ef8-23f6-47e4-a890-6f6dc1475457',
    ];
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
      hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => machineIds.shift() ?? 'unexpected-machine-id',
      provisioningJobIdFactory: () => provisioningJobIds.shift() ?? 'unexpected-job-id',
      tokenFactory: () => ({
        token: 'registration-token',
        hash: hashRegistrationToken('registration-token'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      postgresPasswordFactory: () => 'postgres-secret',
      now: () => new Date('2026-08-24T10:02:00.000Z'),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(null),
      scheduleProvisioningDispatch: vi.fn(),
    });
    const provisionForCheckout = vi.spyOn(service, 'provisionForCheckout');
    const coordinator = createPrebillingProvisioningCoordinator({
      db,
      config: loadPrebillingProvisioningConfig({}),
      customerVpsService: service,
      resolveIdentity: vi.fn().mockResolvedValue({ handle: 'bob' }),
      now: () => new Date('2026-08-24T10:02:00.000Z'),
    });

    await expect(listPaidPrebillingIntentsNeedingPreparation(
      db,
      '2026-08-24T10:02:00.000Z',
    )).resolves.toEqual([expect.objectContaining({ id: 'intent-2', state: 'payment_settling' })]);
    await expect(coordinator.resumePreparation({
      intentId: 'intent-2',
      clerkUserId: 'user_456',
    })).resolves.toBe(true);

    expect(provisionForCheckout).toHaveBeenCalledOnce();
    expect(provisionForCheckout).toHaveBeenCalledWith(expect.objectContaining({
      clerkUserId: 'user_456',
      runtimeSlot: 'primary',
      serverType: 'cpx32',
      location: 'fsn1',
    }), 'intent-2', { dispatch: 'detached' });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-2')).resolves.toMatchObject({
      id: 'intent-2',
      state: 'payment_settling',
      paymentConfirmedAt: '2026-08-24T10:01:00.000Z',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff456',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_456', 'primary')).resolves.toMatchObject({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff456',
      prebillingIntentId: 'intent-2',
      activationState: 'awaiting_billing',
    });
    await expect(listPaidPrebillingIntentsNeedingPreparation(
      db,
      '2026-08-24T10:03:00.000Z',
    )).resolves.toEqual([]);
    await expect(coordinator.reconcilePreparations()).resolves.toEqual({ checked: 0, resumed: 0 });
    expect(provisionForCheckout).toHaveBeenCalledOnce();

    await updateUserMachine(db, '9f05824c-8d0a-4d83-9cb4-b312d43ff456', {
      status: 'failed',
      failureCode: 'provider_timeout',
      failureAt: '2026-08-24T10:03:00.000Z',
    });
    await markPrebillingPreparationFailed(db, {
      intentId: 'intent-2',
      now: '2026-08-24T10:03:00.000Z',
      errorCode: 'provider_timeout',
    });
    await expect(listPaidPrebillingIntentsNeedingPreparation(
      db,
      '2026-08-24T10:04:00.000Z',
    )).resolves.toEqual([expect.objectContaining({ id: 'intent-2', state: 'preparation_failed' })]);

    await expect(coordinator.resumePreparation({
      intentId: 'intent-2',
      clerkUserId: 'user_456',
    })).resolves.toBe(true);
    expect(provisionForCheckout).toHaveBeenCalledTimes(2);
    expect(provisionForCheckout.mock.calls.map(([, intentId]) => intentId)).toEqual([
      'intent-2',
      'intent-2',
    ]);
    await expect(getActiveUserMachineByClerkId(db, 'user_456', 'primary')).resolves.toMatchObject({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff457',
      prebillingIntentId: 'intent-2',
      activationState: 'awaiting_billing',
      attempt: 2,
    });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-2')).resolves.toMatchObject({
      id: 'intent-2',
      state: 'payment_settling',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff457',
      paymentConfirmedAt: '2026-08-24T10:01:00.000Z',
    });
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
      maxActive: 1,
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
    await expect(service.register('registration-token', {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'dev',
    })).resolves.toMatchObject({ registered: true, status: 'running' });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'ready_waiting_for_billing',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
    });
    const reconcileFallbacks = vi.fn().mockResolvedValue(undefined);
    service.setPrebillingFallbackReconciler?.(reconcileFallbacks);
    await service.reconcileProvisioning();
    expect(reconcileFallbacks).toHaveBeenCalledOnce();
  });

  it('deletes a provider server when signed checkout cleanup wins during provider creation', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    await admitPrebillingIntent(db, {
      intentId: 'intent-1', stripeSessionId: 'cs_1', stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1, now: CREATED_AT,
    });
    const hetzner = createMockHetznerClient();
    vi.mocked(hetzner.getServer).mockResolvedValue(null);
    vi.mocked(hetzner.createServer).mockImplementation(async () => {
      await db.transaction((trx) => cleanupExpiredPrebillingCheckout(trx, {
        stripeSessionId: 'cs_1',
        now: EXPIRES_AT,
      }));
      return {
        id: 123456,
        status: 'running',
        serverType: 'cpx32',
        publicIPv4: '203.0.113.10',
        publicIPv6: '2001:db8::/64',
      };
    });
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

    await service.provisionForCheckout({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      serverType: 'cpx32',
      location: 'fsn1',
      developerTools: ['codex', 'claude-code'],
    }, 'intent-1');

    expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeUndefined();
  });

  it('coordinates rollout admission into detached primary provisioning', async () => {
    await seedCheckout('checkout-1', 'user_123');
    const provisionForCheckout = vi.fn().mockResolvedValue({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'provisioning',
      etaSeconds: 90,
    });
    const coordinator = createPrebillingProvisioningCoordinator({
      db,
      config: loadPrebillingProvisioningConfig({
        MATRIX_PREBILLING_PROVISIONING_ENABLED: 'true',
        MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT: '100',
        MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: '1',
      }),
      customerVpsService: { provisionForCheckout } as never,
      resolveIdentity: vi.fn().mockResolvedValue({ handle: 'alice' }),
      intentIdFactory: () => 'intent-1',
      now: () => new Date(CREATED_AT),
    });

    const preparation = await coordinator.createIntent({
      checkoutAttemptId: 'checkout-1',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      serverType: 'cpx32',
      regionSlug: 'region_fsn1',
      developerTools: ['codex', 'claude-code'],
      now: CREATED_AT,
    });
    expect(preparation).toEqual({ intentId: 'intent-1', expiresAt: EXPIRES_AT });
    await expect(coordinator.startPreparation({
      intentId: 'intent-1',
      stripeSessionId: 'cs_1',
      stripeSessionExpiresAt: EXPIRES_AT,
    })).resolves.toBe(true);

    expect(provisionForCheckout).toHaveBeenCalledWith({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      serverType: 'cpx32',
      location: 'fsn1',
      developerTools: ['codex', 'claude-code'],
    }, 'intent-1', { dispatch: 'detached' });
    await expect(coordinator.getPreparationStatus({
      checkoutAttemptId: 'checkout-1', clerkUserId: 'user_123',
    })).resolves.toBe('preparing');
  });

  it('leases fallback provisioning to one platform process', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    // Legacy rows from before fail-closed authorization can still be claimed
    // safely while they age out; new authorization can no longer create one.
    await db.executor.updateTable('prebilling_provisioning_intents').set({
      state: 'authorized',
      authorized_at: CREATED_AT,
    }).where('id', '=', 'intent-1').execute();
    const claims = await Promise.all([1, 2].map(() => claimAuthorizedPrebillingFallbackIntent(db, {
      intentId: 'intent-1', now: CREATED_AT, leaseExpiresAt: EXPIRES_AT,
    })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(claimAuthorizedPrebillingFallbackIntent(db, {
      intentId: 'intent-1', now: EXPIRES_AT, leaseExpiresAt: '2026-08-24T10:36:00.000Z',
    })).resolves.toBeDefined();
  });

  it('records payment first and atomically authorizes the exact machine when it becomes ready', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    const admitted = await admitPrebillingIntent(db, {
      intentId: 'intent-1',
      stripeSessionId: 'cs_1',
      stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1,
      now: CREATED_AT,
    });
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      accessClerkUserIds: [],
      status: 'running',
      imageVersion: 'dev',
      developerTools: ['codex', 'claude-code'],
      registrationTokenHash: null,
      registrationTokenExpiresAt: null,
      provisionedAt: CREATED_AT,
      activationState: 'awaiting_billing',
      prebillingIntentId: 'intent-1',
    });
    expect(await bindPrebillingIntentMachine(db, {
      intentId: 'intent-1',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      expectedRevision: admitted.intent.revision,
      now: CREATED_AT,
    })).toBe(true);
    await expect(getAccessibleActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeUndefined();
    await expect(getRunningUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeUndefined();

    await expect(db.transaction((trx) => authorizePrebillingIntent(trx, {
      intentId: 'intent-1', clerkUserId: 'user_123', runtimeSlot: 'primary', now: CREATED_AT,
    }))).resolves.toEqual({
      authorized: false,
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
    });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'payment_settling',
      paymentConfirmedAt: CREATED_AT,
    });
    await expect(getAccessibleActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeUndefined();
    await expect(db.transaction((trx) => markPrebillingIntentReady(trx, {
      intentId: 'intent-1',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      now: CREATED_AT,
    }))).resolves.toBe(true);
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'authorized',
      paymentConfirmedAt: CREATED_AT,
      authorizedAt: CREATED_AT,
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toMatchObject({
      activationState: 'authorized',
      activationAuthorizedAt: CREATED_AT,
    });
    await expect(getRunningUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeDefined();
    await expect(getAccessibleActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeDefined();
  });

  it('keeps a ready machine fenced until payment authorizes that same machine', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    const admitted = await admitPrebillingIntent(db, {
      intentId: 'intent-1',
      stripeSessionId: 'cs_1',
      stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1,
      now: CREATED_AT,
    });
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      accessClerkUserIds: [],
      status: 'running',
      imageVersion: 'dev',
      developerTools: ['codex', 'claude-code'],
      registrationTokenHash: null,
      registrationTokenExpiresAt: null,
      provisionedAt: CREATED_AT,
      activationState: 'awaiting_billing',
      prebillingIntentId: 'intent-1',
    });
    expect(await bindPrebillingIntentMachine(db, {
      intentId: 'intent-1',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      expectedRevision: admitted.intent.revision,
      now: CREATED_AT,
    })).toBe(true);

    await expect(db.transaction((trx) => markPrebillingIntentReady(trx, {
      intentId: 'intent-1',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      now: CREATED_AT,
    }))).resolves.toBe(true);
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'ready_waiting_for_billing',
      paymentConfirmedAt: null,
    });
    await expect(getAccessibleActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeUndefined();

    await expect(db.transaction((trx) => authorizePrebillingIntent(trx, {
      intentId: 'intent-1', clerkUserId: 'user_123', runtimeSlot: 'primary', now: CREATED_AT,
    }))).resolves.toEqual({
      authorized: true,
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
    });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'authorized',
      paymentConfirmedAt: CREATED_AT,
      authorizedAt: CREATED_AT,
    });
    await expect(getAccessibleActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeDefined();
  });

  it('durably retires an unauthorized machine only from signed checkout expiry', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    const admitted = await admitPrebillingIntent(db, {
      intentId: 'intent-1', stripeSessionId: 'cs_1', stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1, now: CREATED_AT,
    });
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', clerkUserId: 'user_123',
      handle: 'alice', runtimeSlot: 'primary', provisioningClass: 'customer', accessClerkUserIds: [],
      status: 'running', imageVersion: 'dev', developerTools: ['codex'], hetznerServerId: 123456,
      registrationTokenHash: null, registrationTokenExpiresAt: null, provisionedAt: CREATED_AT,
      activationState: 'awaiting_billing', prebillingIntentId: 'intent-1',
    });
    await bindPrebillingIntentMachine(db, {
      intentId: 'intent-1', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      expectedRevision: admitted.intent.revision, now: CREATED_AT,
    });

    await expect(db.transaction((trx) => cleanupExpiredPrebillingCheckout(trx, {
      stripeSessionId: 'cs_1', now: EXPIRES_AT,
    }))).resolves.toEqual({ cleaned: true, intentId: 'intent-1' });
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toBeUndefined();
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'cleaned', machineId: null,
    });
  });

  it('never lets a late checkout-expiry event clean a payment-confirmed intent', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');
    await admitPrebillingIntent(db, {
      intentId: 'intent-1', stripeSessionId: 'cs_1', stripeSessionExpiresAt: EXPIRES_AT,
      maxActive: 1, now: CREATED_AT,
    });
    await expect(db.transaction((trx) => authorizePrebillingIntent(trx, {
      intentId: 'intent-1', clerkUserId: 'user_123', runtimeSlot: 'primary', now: CREATED_AT,
    }))).resolves.toEqual({ authorized: false, machineId: null });

    await expect(db.transaction((trx) => cleanupExpiredPrebillingCheckout(trx, {
      stripeSessionId: 'cs_1', now: EXPIRES_AT,
    }))).resolves.toEqual({ cleaned: false, intentId: 'intent-1' });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'payment_settling',
      paymentConfirmedAt: CREATED_AT,
      cleanedAt: null,
    });
  });

  it('cleans an intent from signed metadata when a crash preceded session binding', async () => {
    await seedCheckout('checkout-1', 'user_123');
    await createIntent('intent-1', 'checkout-1', 'user_123');

    await expect(db.transaction((trx) => cleanupExpiredPrebillingCheckout(trx, {
      stripeSessionId: 'cs_1',
      intentId: 'intent-1',
      clerkUserId: 'user_123',
      now: EXPIRES_AT,
    }))).resolves.toEqual({ cleaned: true, intentId: 'intent-1' });
    await expect(getPrebillingIntentByCheckoutAttempt(db, 'checkout-1')).resolves.toMatchObject({
      state: 'cleaned',
    });
  });

  async function seedCheckout(id: string, clerkUserId: string, serverType = 'cpx32'): Promise<void> {
    const claimed = await claimCheckoutAttempt(db, {
      id,
      clerkUserId,
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      regionSlug: 'region_fsn1',
      serverType,
      developerTools: ['codex', 'claude-code'],
      createdAt: CREATED_AT,
    });
    expect(claimed.claimed).toBe(true);
  }

  async function createIntent(
    id: string,
    checkoutAttemptId: string,
    clerkUserId: string,
    serverType = 'cpx32',
  ): Promise<void> {
    await createPrebillingIntent(db, {
      id,
      checkoutAttemptId,
      clerkUserId,
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      serverType,
      regionSlug: 'region_fsn1',
      developerTools: ['codex', 'claude-code'],
      createdAt: CREATED_AT,
    });
  }
});
