import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  claimUserMachineDelete,
  claimRunningUserMachineResize,
  completeUserMachineRegistration,
  getActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getRunningUserMachineByHandle,
  getUserMachine,
  listPendingProviderDeletions,
  promoteHostBundleChannel,
  updateUserMachine,
  upsertHostBundleRelease,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { isPreviewMachine } from '../../packages/platform/src/customer-vps-preview.js';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import {
  buildCustomerVpsR2Key,
  buildVpsMeta,
  createCustomerVpsSystemStore,
  validateDbLatestPointer,
} from '../../packages/platform/src/customer-vps-r2.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await destroyTestPlatformDb(db);
  });

  function createTestConfig(overrides: Partial<ReturnType<typeof loadCustomerVpsConfig>> = {}) {
    return {
      ...loadCustomerVpsConfig({
        PLATFORM_PORT: '9000',
        PLATFORM_SECRET: 'platform-secret',
        HETZNER_API_TOKEN: 'token',
        S3_ACCESS_KEY_ID: 'r2-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-secret-key',
        S3_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'matrixos-sync',
        POSTHOG_TOKEN: 'phc_public',
        POSTHOG_PROJECT_TOKEN: 'phc_project',
        POSTHOG_HOST: 'https://eu.i.posthog.com',
        NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.posthog.com',
        NEXT_PUBLIC_POSTHOG_API_HOST: '/relay',
      }),
      ...overrides,
    };
  }

  function createService(overrides: Parameters<typeof createCustomerVpsService>[0] = {} as any) {
    const hetzner = createMockHetznerClient(overrides.hetzner);
    const systemStore = createMockCustomerVpsSystemStore(overrides.systemStore);
    const service = createCustomerVpsService({
      db,
      config: createTestConfig(),
      hetzner,
      systemStore,
      tokenFactory: () => ({
        token: 'registration-token',
        hash: hashRegistrationToken('registration-token'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      machineIdFactory: () => '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      postgresPasswordFactory: () => 'postgres-secret',
      now: () => new Date('2026-04-26T12:00:00.000Z'),
      ...overrides,
    });
    return { service, hetzner, systemStore };
  }

  function activeEntitlement(overrides: Partial<BillingEntitlement> = {}): BillingEntitlement {
    return {
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_builder',
      status: 'active',
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx32',
      allowedServerTypes: ['cpx22', 'cpx32'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_builder_monthly',
      gracePeriodEndsAt: '2026-05-30T00:00:00.000Z',
      effectiveFrom: '2026-05-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-05-30T00:00:00.000Z',
      ...overrides,
    };
  }

  it('defaults new customer VPS provisioning to the stable host bundle channel', () => {
    const config = loadCustomerVpsConfig({
      PLATFORM_PUBLIC_URL: 'https://app.matrix-os.com',
    });

    expect(config.imageVersion).toBe('stable');
    expect(config.hostBundleUrl).toBe('https://app.matrix-os.com/system-bundles/stable/matrix-host-bundle.tar.gz');
  });

  it('does not use the private PostHog ingest host as the public browser host', () => {
    const config = loadCustomerVpsConfig({
      POSTHOG_HOST: 'https://eu.i.posthog.com',
      NEXT_PUBLIC_POSTHOG_API_HOST: '/relay',
    });

    expect(config.posthogHost).toBe('https://eu.i.posthog.com');
    expect(config.posthogPublicHost).toBe('https://eu.posthog.com');
  });

  it('keeps the preview provisioning limit bounded for missing or invalid configuration', () => {
    expect(loadCustomerVpsConfig({}).previewProvisioningLimit).toBe(8);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '4' }).previewProvisioningLimit).toBe(4);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '0' }).previewProvisioningLimit).toBe(8);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '17' }).previewProvisioningLimit).toBe(8);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '2.5' }).previewProvisioningLimit).toBe(8);
  });

  it('classifies only server-marked dedicated and legacy preview runtime slots as previews', () => {
    expect(isPreviewMachine({ handle: 'pr-897', runtimeSlot: 'pr-897', provisioningClass: 'preview' })).toBe(true);
    expect(isPreviewMachine({ handle: 'pr-703', runtimeSlot: 'preview', provisioningClass: 'preview' })).toBe(true);
    expect(isPreviewMachine({ handle: 'pr-897', runtimeSlot: 'pr-897', provisioningClass: 'customer' })).toBe(false);
    expect(isPreviewMachine({ handle: 'pr-897', runtimeSlot: 'primary', provisioningClass: 'preview' })).toBe(false);
    expect(isPreviewMachine({ handle: 'alice', runtimeSlot: 'pr-897', provisioningClass: 'preview' })).toBe(false);
  });

  it('provisions a user machine idempotently by clerkUserId', async () => {
    const { service, hetzner } = createService();

    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice', developerTools: ['codex', 'pi'] });
    const second = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(first).toEqual({ machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', status: 'provisioning', etaSeconds: 90 });
    expect(second).toEqual(first);
    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.hetznerServerId).toBe(123456);
    expect(row?.provisioningClass).toBe('customer');
    expect(row?.registrationTokenHash).toBe(hashRegistrationToken('registration-token'));
    expect(row?.developerTools).toEqual(['codex', 'pi']);
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain("MATRIX_DEVELOPER_TOOLS='codex pi'");
  });

  it('preserves an intentional empty developer tool selection', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice', developerTools: [] });

    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.developerTools).toEqual([]);
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain("MATRIX_DEVELOPER_TOOLS=''");
  });

  it('uses the active billing entitlement server type when provisioning new machines', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement()),
    });

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(vi.mocked(hetzner.createServer).mock.calls[0]?.[0]).toMatchObject({
      serverType: 'cpx32',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toMatchObject({
      serverType: 'cpx32',
    });
  });

  it('falls back to the first allowed billing server type when the default is missing', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        defaultServerType: '',
        allowedServerTypes: ['cpx22', 'cpx32'],
      })),
    });

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(vi.mocked(hetzner.createServer).mock.calls[0]?.[0]).toMatchObject({
      serverType: 'cpx22',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toMatchObject({
      serverType: 'cpx22',
    });
  });

  it('allows provisioning during the three-day billing grace period', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        status: 'past_due',
        gracePeriodEndsAt: '2026-04-27T00:00:00.000Z',
      })),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).resolves.toMatchObject({
      status: 'provisioning',
    });
    expect(hetzner.createServer).toHaveBeenCalledOnce();
  });

  it('blocks new machine provisioning after billing access expires', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        status: 'past_due',
        gracePeriodEndsAt: '2026-04-25T23:59:59.000Z',
      })),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });

  it('blocks extra machines beyond the entitlement slot count without deleting existing machines', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({ maxRuntimeSlots: 1 })),
    });

    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice-tools', runtimeSlot: 'tools' })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });

    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    await expect(getUserMachine(db, primary.machineId)).resolves.toMatchObject({
      handle: 'alice',
      deletedAt: null,
    });
  });

  it('provisions operator previews outside customer billing slots while enforcing the preview cap', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
      '188d9ce1-395d-4d4c-a7b7-22754c3ab991',
    ];
    const resolveBillingEntitlement = vi.fn().mockResolvedValue(activeEntitlement({ maxRuntimeSlots: 1 }));
    const { service, hetzner } = createService({
      config: createTestConfig({ previewProvisioningLimit: 1 }),
      machineIdFactory: () => ids[nextId++] ?? ids[2]!,
      resolveBillingEntitlement,
    });

    await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    const preview = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });
    const repeated = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });

    expect(repeated).toEqual(preview);
    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-898',
      runtimeSlot: 'pr-898',
    })).rejects.toMatchObject({
      status: 429,
      code: 'quota_exceeded',
      publicMessage: 'Preview capacity unavailable',
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(hetzner.createServer).mock.calls[1]?.[0]).toMatchObject({
      name: 'matrix-pr-897',
      serverType: 'cpx22',
    });
    expect(resolveBillingEntitlement).toHaveBeenCalledOnce();
    await expect(getUserMachine(db, preview.machineId)).resolves.toMatchObject({
      provisioningClass: 'preview',
    });
  });

  it('does not let an existing preview consume a customer billing slot', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({ maxRuntimeSlots: 1 })),
    });

    await service.provisionPreview({ clerkUserId: 'user_123', handle: 'pr-897', runtimeSlot: 'pr-897' });
    await expect(service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
    })).resolves.toMatchObject({ status: 'provisioning' });

    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
  });

  it('keeps customer-provisioned preview-shaped machines in billing slot counts', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({ maxRuntimeSlots: 1 })),
    });

    await service.provision({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });
    await expect(service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
    })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });

    expect(hetzner.createServer).toHaveBeenCalledOnce();
  });

  it('lets the operator path adopt a legacy preview slot without creating a second server', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({ maxRuntimeSlots: 1 })),
    });

    const previewShapedCustomer = await service.provision({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'preview',
    });
    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    })).resolves.toEqual(previewShapedCustomer);
    await expect(getUserMachine(db, previewShapedCustomer.machineId)).resolves.toMatchObject({
      provisioningClass: 'preview',
      runtimeSlot: 'preview',
    });
    await expect(service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
    })).resolves.toMatchObject({ status: 'provisioning' });

    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
  });

  it('does not adopt a legacy preview slot owned by another preview handle', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
    });

    const otherPreview = await service.provision({
      clerkUserId: 'user_123',
      handle: 'pr-896',
      runtimeSlot: 'preview',
    });
    const requestedPreview = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });

    expect(requestedPreview.machineId).not.toBe(otherPreview.machineId);
    await expect(getUserMachine(db, otherPreview.machineId)).resolves.toMatchObject({
      provisioningClass: 'customer',
      runtimeSlot: 'preview',
    });
    await expect(getUserMachine(db, requestedPreview.machineId)).resolves.toMatchObject({
      provisioningClass: 'preview',
      runtimeSlot: 'pr-897',
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
  });

  it('rejects an exact preview slot owned by another handle without reclassifying it', async () => {
    const { service, hetzner } = createService();

    const customerMachine = await service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'pr-897',
    });
    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    })).rejects.toMatchObject({
      status: 409,
      code: 'invalid_state',
      publicMessage: 'Preview slot unavailable',
    });

    await expect(getUserMachine(db, customerMachine.machineId)).resolves.toMatchObject({
      handle: 'alice',
      provisioningClass: 'customer',
    });
    expect(hetzner.createServer).toHaveBeenCalledOnce();
  });

  it('prefers a live matching legacy preview over a failed exact slot', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
      '188d9ce1-395d-4d4c-a7b7-22754c3ab991',
    ];
    const { service, hetzner } = createService({
      config: createTestConfig({ previewProvisioningLimit: 1 }),
      machineIdFactory: () => ids[nextId++] ?? ids[2]!,
    });

    const failedExact = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });
    await updateUserMachine(db, failedExact.machineId, {
      status: 'failed',
      failureCode: 'provider_unavailable',
      failureAt: '2026-04-26T12:05:00.000Z',
    });
    const liveLegacy = await service.provision({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'preview',
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    })).resolves.toEqual(liveLegacy);
    await expect(getUserMachine(db, liveLegacy.machineId)).resolves.toMatchObject({
      provisioningClass: 'preview',
      runtimeSlot: 'preview',
    });
    await expect(getUserMachine(db, failedExact.machineId)).resolves.toMatchObject({
      deletedAt: '2026-04-26T12:00:00.000Z',
      status: 'failed',
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
  });

  it('retires a failed exact slot when the matching legacy preview was already adopted', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
    });

    const failedExact = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });
    await updateUserMachine(db, failedExact.machineId, {
      status: 'failed',
      failureCode: 'provider_unavailable',
      failureAt: '2026-04-26T12:05:00.000Z',
    });
    const adoptedLegacy = await service.provision({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'preview',
    });
    await updateUserMachine(db, adoptedLegacy.machineId, { provisioningClass: 'preview' });

    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    })).resolves.toEqual(adoptedLegacy);
    await expect(getUserMachine(db, failedExact.machineId)).resolves.toMatchObject({
      deletedAt: '2026-04-26T12:00:00.000Z',
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
  });

  it('retires failed exact and legacy previews before retry capacity checks', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
      '188d9ce1-395d-4d4c-a7b7-22754c3ab991',
    ];
    const { service, hetzner } = createService({
      config: createTestConfig({ previewProvisioningLimit: 1 }),
      machineIdFactory: () => ids[nextId++] ?? ids[2]!,
    });

    const failedExact = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });
    await updateUserMachine(db, failedExact.machineId, {
      status: 'failed',
      failureCode: 'provider_unavailable',
      failureAt: '2026-04-26T12:05:00.000Z',
    });
    const failedLegacy = await service.provision({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'preview',
    });
    await updateUserMachine(db, failedLegacy.machineId, {
      provisioningClass: 'preview',
      status: 'failed',
      failureCode: 'provider_unavailable',
      failureAt: '2026-04-26T12:05:00.000Z',
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    })).resolves.toMatchObject({
      machineId: ids[2],
      status: 'provisioning',
    });
    await expect(getUserMachine(db, failedExact.machineId)).resolves.toMatchObject({
      deletedAt: '2026-04-26T12:00:00.000Z',
    });
    await expect(getUserMachine(db, failedLegacy.machineId)).resolves.toMatchObject({
      deletedAt: '2026-04-26T12:00:00.000Z',
    });
    await expect(listPendingProviderDeletions(
      db,
      '2026-04-26T12:00:00.000Z',
      10,
    )).resolves.toHaveLength(2);
    expect(hetzner.createServer).toHaveBeenCalledTimes(3);
  });

  it('counts failed distinct previews until they are retried or deleted', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
      '188d9ce1-395d-4d4c-a7b7-22754c3ab991',
    ];
    const { service, hetzner } = createService({
      config: createTestConfig({ previewProvisioningLimit: 1 }),
      machineIdFactory: () => ids[nextId++] ?? ids[2]!,
    });

    const failedPreview = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });
    await updateUserMachine(db, failedPreview.machineId, {
      status: 'failed',
      failureCode: 'provider_unavailable',
      failureAt: '2026-04-26T12:05:00.000Z',
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-898',
      runtimeSlot: 'pr-898',
    })).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    })).resolves.toMatchObject({ status: 'provisioning' });

    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
  });

  it('rejects requested Hetzner server types outside the entitlement catalog', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22'],
        defaultServerType: 'cpx22',
      })),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx52' })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });

  it('resizes a running machine in place without deleting or recreating owner data', async () => {
    const getServer = vi.fn()
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx22', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'migrating', serverType: 'cpx22', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx32', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'running', serverType: 'cpx32', publicIPv4: '203.0.113.10' });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(service.resize({
      machineId: provisioned.machineId,
      serverType: 'cpx32',
    })).resolves.toEqual({
      machineId: provisioned.machineId,
      serverType: 'cpx32',
      status: 'running',
    });

    expect(hetzner.shutdownServer).toHaveBeenCalledWith(123456);
    expect(hetzner.powerOffServer).not.toHaveBeenCalled();
    expect(hetzner.resizeServer).toHaveBeenCalledWith(123456, { serverType: 'cpx32', upgradeDisk: false });
    expect(hetzner.powerOnServer).toHaveBeenCalledWith(123456);
    expect(vi.mocked(hetzner.shutdownServer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(hetzner.resizeServer).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(hetzner.resizeServer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(hetzner.powerOnServer).mock.invocationCallOrder[0],
    );
    expect(getServer).toHaveBeenCalledTimes(4);
    expect(getServer.mock.invocationCallOrder[2]).toBeLessThan(
      vi.mocked(hetzner.powerOnServer).mock.invocationCallOrder[0],
    );
    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    expect(hetzner.deleteServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      status: 'running',
      serverType: 'cpx32',
      deletedAt: null,
    });
  });

  it('falls back to hard poweroff when graceful resize shutdown is rejected', async () => {
    const getServer = vi.fn()
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx22', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx32', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'running', serverType: 'cpx32', publicIPv4: '203.0.113.10' });
    const shutdownServer = vi.fn().mockRejectedValue(new CustomerVpsError(
      500,
      'provider_unavailable',
      'Provisioning provider unavailable',
    ));
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer, shutdownServer }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(service.resize({
      machineId: provisioned.machineId,
      serverType: 'cpx32',
    })).resolves.toMatchObject({
      machineId: provisioned.machineId,
      serverType: 'cpx32',
      status: 'running',
    });

    expect(hetzner.shutdownServer).toHaveBeenCalledWith(123456);
    expect(hetzner.powerOffServer).toHaveBeenCalledWith(123456);
    expect(vi.mocked(hetzner.shutdownServer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(hetzner.powerOffServer).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(hetzner.powerOffServer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(hetzner.resizeServer).mock.invocationCallOrder[0],
    );
  });

  it('keeps resize claimed when hard poweroff is accepted but off state is not confirmed', async () => {
    vi.useFakeTimers();
    const getServer = vi.fn().mockResolvedValue({
      id: 123456,
      status: 'stopping',
      serverType: 'cpx22',
      publicIPv4: '203.0.113.10',
    });
    const shutdownServer = vi.fn().mockRejectedValue(new CustomerVpsError(
      500,
      'provider_unavailable',
      'Provisioning provider unavailable',
    ));
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer, shutdownServer }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const resize = service.resize({ machineId: provisioned.machineId, serverType: 'cpx32' });
    const resizeExpectation = expect(resize).rejects.toMatchObject({
      code: 'provider_timeout',
    });
    await vi.advanceTimersByTimeAsync(91_000);

    await resizeExpectation;
    expect(hetzner.powerOffServer).toHaveBeenCalledTimes(1);
    expect(hetzner.resizeServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      status: 'resizing',
      serverType: 'cpx22',
      failureCode: null,
      resizeTargetServerType: 'cpx32',
    });
  });

  it('keeps resize claimed when provider change_type is accepted but does not settle', async () => {
    vi.useFakeTimers();
    const getServer = vi.fn()
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx22', publicIPv4: '203.0.113.10' })
      .mockResolvedValue({ id: 123456, status: 'migrating', serverType: 'cpx22', publicIPv4: '203.0.113.10' });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const resize = service.resize({ machineId: provisioned.machineId, serverType: 'cpx32' });
    const resizeExpectation = expect(resize).rejects.toMatchObject({
      code: 'provider_timeout',
    });
    await vi.advanceTimersByTimeAsync(91_000);

    await resizeExpectation;
    expect(hetzner.resizeServer).toHaveBeenCalledWith(123456, {
      serverType: 'cpx32',
      upgradeDisk: false,
    });
    expect(hetzner.powerOnServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      status: 'resizing',
      serverType: 'cpx22',
      failureCode: null,
      resizeTargetServerType: 'cpx32',
    });
  });

  it('keeps waiting on graceful shutdown after a transient provider read failure', async () => {
    vi.useFakeTimers();
    const getServer = vi.fn()
      .mockRejectedValueOnce(new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable'))
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx22', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx32', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'running', serverType: 'cpx32', publicIPv4: '203.0.113.10' });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const resize = service.resize({ machineId: provisioned.machineId, serverType: 'cpx32' });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resize).resolves.toMatchObject({
      machineId: provisioned.machineId,
      serverType: 'cpx32',
      status: 'running',
    });
    expect(hetzner.shutdownServer).toHaveBeenCalledWith(123456);
    expect(hetzner.powerOffServer).not.toHaveBeenCalled();
  });

  it('does not issue duplicate poweron when the resize poweron wait times out', async () => {
    vi.useFakeTimers();
    const getServer = vi.fn()
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx22', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx32', publicIPv4: '203.0.113.10' })
      .mockResolvedValue({ id: 123456, status: 'starting', serverType: 'cpx32', publicIPv4: '203.0.113.10' });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const resize = service.resize({ machineId: provisioned.machineId, serverType: 'cpx32' });
    const resizeExpectation = expect(resize).rejects.toMatchObject({
      code: 'provider_timeout',
    });
    await vi.advanceTimersByTimeAsync(91_000);

    await resizeExpectation;
    expect(hetzner.powerOnServer).toHaveBeenCalledTimes(1);
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      status: 'resizing',
      serverType: 'cpx22',
      failureCode: null,
      resizeTargetServerType: 'cpx32',
    });
  });

  it('keeps resize claimed when rollback poweron is accepted but not confirmed', async () => {
    vi.useFakeTimers();
    const getServer = vi.fn()
      .mockResolvedValueOnce({ id: 123456, status: 'off', serverType: 'cpx22', publicIPv4: '203.0.113.10' })
      .mockResolvedValue({ id: 123456, status: 'starting', serverType: 'cpx22', publicIPv4: '203.0.113.10' });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        getServer,
        resizeServer: vi.fn().mockRejectedValue(new CustomerVpsError(
          500,
          'provider_unavailable',
          'Provisioning provider unavailable',
        )),
      }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const resize = service.resize({ machineId: provisioned.machineId, serverType: 'cpx32' });
    const resizeExpectation = expect(resize).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    await vi.advanceTimersByTimeAsync(91_000);

    await resizeExpectation;
    expect(hetzner.powerOnServer).toHaveBeenCalledTimes(1);
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      status: 'resizing',
      serverType: 'cpx22',
      failureCode: null,
      resizeTargetServerType: 'cpx32',
    });
  });

  it('returns running without provider work when the machine is already on the requested type', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement()),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx32' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(service.resize({
      machineId: provisioned.machineId,
      serverType: 'cpx32',
    })).resolves.toEqual({
      machineId: provisioned.machineId,
      serverType: 'cpx32',
      status: 'running',
    });

    expect(hetzner.shutdownServer).not.toHaveBeenCalled();
    expect(hetzner.powerOffServer).not.toHaveBeenCalled();
    expect(hetzner.resizeServer).not.toHaveBeenCalled();
    expect(hetzner.powerOnServer).not.toHaveBeenCalled();
  });

  it('rejects a second resize while the first resize has claimed the machine', async () => {
    let markResizeStarted!: () => void;
    let releaseResize!: () => void;
    const resizeStarted = new Promise<void>((resolve) => {
      markResizeStarted = resolve;
    });
    const getServer = vi.fn()
      .mockResolvedValueOnce({ id: 123456, status: 'off', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'off', publicIPv4: '203.0.113.10' })
      .mockResolvedValueOnce({ id: 123456, status: 'running', publicIPv4: '203.0.113.10' });
    const resizeServer = vi.fn().mockImplementation(async () => {
      markResizeStarted();
      await new Promise<void>((resolve) => {
        releaseResize = resolve;
      });
    });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer, resizeServer }),
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
        defaultServerType: 'cpx32',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const firstResize = service.resize({ machineId: provisioned.machineId, serverType: 'cpx32' });
    await resizeStarted;
    await expect(service.resize({ machineId: provisioned.machineId, serverType: 'cpx52' })).rejects.toMatchObject({
      status: 409,
      publicMessage: 'Machine cannot resize',
    });
    await expect(service.delete(provisioned.machineId)).rejects.toMatchObject({
      status: 409,
      publicMessage: 'Machine cannot delete',
    });
    await expect(service.recover({ clerkUserId: 'user_123', allowEmpty: true })).rejects.toMatchObject({
      status: 409,
      publicMessage: 'Machine cannot recover',
    });
    expect(hetzner.resizeServer).toHaveBeenCalledTimes(1);

    releaseResize();
    await firstResize;
  });

  it('rejects machine resize requests outside the active entitlement without provider mutation', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22'],
        defaultServerType: 'cpx22',
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(service.resize({
      machineId: provisioned.machineId,
      serverType: 'cpx52',
    })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });

    expect(hetzner.resizeServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      serverType: 'cpx22',
      status: 'running',
      deletedAt: null,
    });
  });

  it('pins channel image versions to the current immutable host bundle release at provision time', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.25-80',
      channel: 'stable',
      gitCommit: 'adb12c560b8e6253fd0047eb2375b379e7659cbe',
      gitRef: 'main',
      buildTime: '2026-05-25T11:58:42.274Z',
      bundleKey: 'system-bundles/v2026.05.25-80/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.25-80/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1_257_725_742,
      severity: 'normal',
      updateType: 'manual',
      changelog: 'Release latest main host bundle',
      createdAt: '2026-05-25T12:14:58.275Z',
    });
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.25-80');
    const { service, hetzner } = createService();

    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect((await getUserMachine(db, provisioned.machineId))?.imageVersion).toBe('v2026.05.25-80');
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain(
      'MATRIX_HOST_BUNDLE_URL=http://localhost:9000/system-bundles/v2026.05.25-80/matrix-host-bundle.tar.gz',
    );
    expect(createInput?.userData).toContain('MATRIX_IMAGE_VERSION=v2026.05.25-80');
    expect(createInput?.userData).toContain('MATRIX_UPDATE_CHANNEL=stable');
  });

  it('can provision an isolated staging runtime for the same Clerk user', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    });

    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    const staging = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });
    const stagingAgain = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });

    expect(primary.machineId).toBe(ids[0]);
    expect(staging.machineId).toBe(ids[1]);
    expect(stagingAgain).toEqual(staging);
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toMatchObject({
      handle: 'alice',
      runtimeSlot: 'primary',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'staging')).resolves.toMatchObject({
      handle: 'alice-staging',
      runtimeSlot: 'staging',
    });
  });

  it('resolves staging machines by distinct handle for auth and sync fallback paths', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service } = createService({
      machineIdFactory: () => ids[nextId++] ?? '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    });

    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    const staging = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });
    await updateUserMachine(db, primary.machineId, {
      status: 'running',
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });
    await updateUserMachine(db, staging.machineId, {
      status: 'running',
      publicIPv4: '203.0.113.11',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(getActiveUserMachineByHandle(db, 'alice-staging')).resolves.toMatchObject({
      machineId: staging.machineId,
      runtimeSlot: 'staging',
    });
    await expect(getRunningUserMachineByHandle(db, 'alice-staging')).resolves.toMatchObject({
      machineId: staging.machineId,
      runtimeSlot: 'staging',
      status: 'running',
    });
    await expect(getRunningUserMachineByHandle(db, 'alice-staging', 'primary')).resolves.toBeUndefined();
  });

  it('templates the platform verification token into provisioned customer hosts', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const expected = createHmac('sha256', 'platform-secret').update('alice').digest('hex');
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain(`UPGRADE_TOKEN=${expected}`);
    expect(createInput?.userData).toContain(`MATRIX_AUTH_TOKEN=${expected}`);
    expect(createInput?.userData).toContain(`MATRIX_CODE_PROXY_TOKEN=${expected}`);
    expect(createInput?.userData).toContain('PLATFORM_INTERNAL_URL=http://localhost:9000');
    expect(createInput?.userData).not.toContain('PIPEDREAM_CLIENT_SECRET');
  });

  it('templates R2 credentials into provisioned customer hosts for backups', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain("AWS_ACCESS_KEY_ID='r2-access-key'");
    expect(createInput?.userData).toContain("AWS_SECRET_ACCESS_KEY='r2-secret-key'");
    expect(createInput?.userData).toContain("R2_ENDPOINT='https://r2.example'");
  });

  it('templates public PostHog telemetry into provisioned customer hosts', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain('POSTHOG_TOKEN=phc_public');
    expect(createInput?.userData).toContain('POSTHOG_PROJECT_TOKEN=phc_project');
    expect(createInput?.userData).toContain('POSTHOG_HOST=https://eu.i.posthog.com');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_KEY=phc_public');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_project');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_HOST=https://eu.posthog.com');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_API_HOST=/relay');
  });

  it('records a failed status with a generic failure code when Hetzner create fails', async () => {
    const { service } = createService({
      hetzner: createMockHetznerClient({
        createServer: vi.fn().mockRejectedValue(new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable')),
      }),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).rejects.toMatchObject({
      status: 429,
      code: 'quota_exceeded',
    });

    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe('quota_exceeded');
  });

  it('deletes a newly-created Hetzner server when recording it in the DB fails', async () => {
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        createServer: vi.fn().mockImplementation(async () => {
          await db.destroy();
          return {
            id: 654321,
            status: 'running',
            publicIPv4: '203.0.113.20',
          };
        }),
        deleteServer,
      }),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).rejects.toMatchObject({
      status: 500,
      code: 'provider_unavailable',
    });

    expect(hetzner.createServer).toHaveBeenCalledOnce();
    expect(deleteServer).toHaveBeenCalledWith(654321);
  });

  it('registers a provisioned machine and consumes the registration token', async () => {
    const { service, systemStore } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const registered = await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      publicIPv6: '2001:db8::10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    expect(registered).toEqual({ registered: true, status: 'running' });
    const row = await getUserMachine(db, provisioned.machineId);
    expect(row?.status).toBe('running');
    expect(row?.registrationTokenHash).toBeNull();
    expect(row?.registrationTokenExpiresAt).toBeNull();
    expect(systemStore.writtenMeta).toHaveLength(1);
  });

  it('returns a warning when registration metadata cannot be persisted', async () => {
    const { service } = createService({
      systemStore: createMockCustomerVpsSystemStore({
        writeVpsMeta: vi.fn().mockRejectedValue(new Error('r2 unavailable')),
      }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await expect(service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    })).resolves.toEqual({
      registered: true,
      status: 'running',
      warnings: ['vps_meta_persistence_failed'],
    });
  });

  it('retries metadata persistence for running machines during reconciliation', async () => {
    const writeVpsMeta = vi.fn()
      .mockRejectedValueOnce(new Error('r2 unavailable'))
      .mockResolvedValueOnce(undefined);
    const { service } = createService({
      systemStore: createMockCustomerVpsSystemStore({ writeVpsMeta }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await service.reconcileProvisioning();

    expect(writeVpsMeta).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid registration tokens without changing machine state', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await expect(service.register('wrong-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    })).rejects.toMatchObject({ status: 401 });

    expect((await getUserMachine(db, provisioned.machineId))?.status).toBe('provisioning');
  });

  it('rejects registration with a private IPv4 address', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await expect(service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '10.0.0.5',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_state',
    });

    expect((await getUserMachine(db, provisioned.machineId))?.status).toBe('provisioning');
  });

  it('does not complete registration after the machine leaves a registerable state', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    const row = (await getUserMachine(db, provisioned.machineId))!;

    await updateUserMachine(db, provisioned.machineId, {
      status: 'failed',
      failureCode: 'not_found',
      failureAt: '2026-04-26T12:00:00.000Z',
    });

    const updated = await completeUserMachineRegistration(
      db,
      provisioned.machineId,
      123456,
      row.registrationTokenHash!,
      '2026-04-26T12:00:00.000Z',
      {
        status: 'running',
        publicIPv4: '203.0.113.10',
        imageVersion: 'matrix-os-host-2026.04.26-1',
      },
    );

    expect(updated).toBeUndefined();
    expect(await getUserMachine(db, provisioned.machineId)).toMatchObject({
      status: 'failed',
      publicIPv4: '203.0.113.10',
      failureCode: 'not_found',
    });
  });

  it('builds valid R2 VPS metadata from a running machine row', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const row = (await getUserMachine(db, provisioned.machineId))!;
    expect(buildVpsMeta(row, '2026-04-26T12:05:00.000Z')).toMatchObject({
      version: 1,
      userId: 'user_123',
      machineId: provisioned.machineId,
      status: 'running',
      publicIPv4: '203.0.113.10',
    });
  });

  it('normalizes Postgres timestamp text when building VPS metadata', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const row = (await getUserMachine(db, provisioned.machineId))!;
    const meta = buildVpsMeta(
      {
        ...row,
        provisionedAt: '2026-04-26 12:00:00+00',
      },
      '2026-05-04 10:31:31.81222+00',
    );

    expect(meta.provisionedAt).toBe('2026-04-26T12:00:00.000Z');
    expect(meta.lastSyncAt).toBe('2026-05-04T10:31:31.812Z');
  });

  it('validates R2 latest pointers without accepting paths or URLs', () => {
    expect(validateDbLatestPointer('system/db/snapshots/2026-04-26T1800Z.dump')).toBe(true);
    expect(validateDbLatestPointer('system/runtime-slots/staging/db/snapshots/2026-04-26T1800Z.dump')).toBe(true);
    expect(validateDbLatestPointer('../system/db/snapshots/2026-04-26T1800Z.dump')).toBe(false);
    expect(validateDbLatestPointer('https://example.com/snapshot.dump')).toBe(false);
    expect(validateDbLatestPointer('system/db/snapshots/not-a-date.dump')).toBe(false);
    expect(validateDbLatestPointer('system/runtime-slots/staging-/db/snapshots/2026-04-26T1800Z.dump')).toBe(false);
  });

  it('writes VPS metadata to the scoped user R2 key', async () => {
    const writes: Array<{ key: string; body: string; signal?: AbortSignal }> = [];
    const reads: Array<{ key: string; signal?: AbortSignal }> = [];
    const store = createCustomerVpsSystemStore({
      r2PrefixRoot: 'matrixos-sync',
      r2: {
        async putObject(key, body, options) {
          writes.push({ key, body: String(body), signal: options?.signal });
          return {};
        },
        async getObject(key, options) {
          reads.push({ key, signal: options?.signal });
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        },
      },
    });

    const { service } = createService({ systemStore: store });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe('matrixos-sync/user_123/system/vps-meta.json');
    expect(writes[0].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(writes[0].body)).toMatchObject({
      userId: 'user_123',
      machineId: provisioned.machineId,
      status: 'running',
    });
    await expect(store.hasDbLatest('user_123')).resolves.toBe(false);
    await expect(store.hasDbLatest('user_123', 'staging')).resolves.toBe(false);
    expect(reads[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(reads[0]?.key).toBe('matrixos-sync/user_123/system/db/latest');
    expect(reads[1]?.key).toBe('matrixos-sync/user_123/system/runtime-slots/staging/db/latest');
    expect(buildCustomerVpsR2Key('matrixos-sync/', 'user_123', 'system/db/latest')).toBe(
      'matrixos-sync/user_123/system/db/latest',
    );
    expect(() => buildCustomerVpsR2Key('matrixos-sync', 'user_123', '../system/db/latest')).toThrow(
      'Invalid customer VPS system key',
    );
  });

  it('refuses recovery without an R2 latest pointer unless allowEmpty is set', async () => {
    const hetzner = createMockHetznerClient();
    const systemStore = createMockCustomerVpsSystemStore({
      hasDbLatest: vi.fn().mockResolvedValue(false),
    });
    const { service } = createService({ hetzner, systemStore });
    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await expect(service.recover({ clerkUserId: 'user_123' })).rejects.toMatchObject({
      status: 409,
      publicMessage: 'No backup snapshot available',
    });
    expect(hetzner.deleteServer).not.toHaveBeenCalled();
  });

  it('creates a replacement machine in recovering state from R2 preflight', async () => {
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
    ];
    const hetzner = createMockHetznerClient({
      createServer: vi
        .fn()
        .mockResolvedValueOnce({
          id: 123456,
          status: 'running',
          publicIPv4: '203.0.113.10',
          publicIPv6: '2001:db8::10',
        })
        .mockResolvedValueOnce({
          id: 789012,
          status: 'running',
          publicIPv4: '203.0.113.11',
          publicIPv6: '2001:db8::11',
        }),
    });
    const systemStore = createMockCustomerVpsSystemStore({
      hasDbLatest: vi.fn().mockResolvedValue(true),
    });
    const { service } = createService({
      hetzner,
      systemStore,
      machineIdFactory: () => machineIds.shift()!,
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const recovered = await service.recover({ clerkUserId: 'user_123' });

    expect(recovered).toMatchObject({
      oldMachineId: provisioned.machineId,
      machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      runtimeSlot: 'primary',
      status: 'recovering',
    });
    expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
    expect(
      vi.mocked(hetzner.createServer).mock.invocationCallOrder[1],
    ).toBeLessThan(vi.mocked(hetzner.deleteServer).mock.invocationCallOrder[0]);
    const secondCreate = vi.mocked(hetzner.createServer).mock.calls[1][0];
    expect(secondCreate.name).toBe('matrix-alice-f973bb98');
    expect(secondCreate.labels).toMatchObject({ runtime_slot: 'primary' });
    const row = (await getUserMachine(db, recovered.machineId))!;
    expect(row).toMatchObject({
      clerkUserId: 'user_123',
      handle: 'alice',
      status: 'recovering',
      hetznerServerId: 789012,
      publicIPv4: '203.0.113.11',
    });
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toBeUndefined();
  });

  it('recovers a legacy machine with no stored server type using the first allowed billing type', async () => {
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
    ];
    const hetzner = createMockHetznerClient({
      createServer: vi
        .fn()
        .mockResolvedValueOnce({ id: 123456, status: 'running', publicIPv4: '203.0.113.10' })
        .mockResolvedValueOnce({ id: 789012, status: 'running', publicIPv4: '203.0.113.11' }),
    });
    const { service } = createService({
      hetzner,
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) }),
      machineIdFactory: () => machineIds.shift()!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        defaultServerType: '',
        allowedServerTypes: ['cpx22', 'cpx32'],
      })),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });
    await updateUserMachine(db, provisioned.machineId, { serverType: null });

    const recovered = await service.recover({ clerkUserId: 'user_123' });

    expect(recovered.status).toBe('recovering');
    expect(vi.mocked(hetzner.createServer).mock.calls[1]?.[0]).toMatchObject({
      serverType: 'cpx22',
    });
  });

  it('recovers the requested runtime slot without touching primary', async () => {
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      '7fe6cb68-738b-46a4-a338-f5fb74ac9123',
    ];
    const hetzner = createMockHetznerClient({
      createServer: vi
        .fn()
        .mockResolvedValueOnce({ id: 123456, status: 'running', publicIPv4: '203.0.113.10' })
        .mockResolvedValueOnce({ id: 789012, status: 'running', publicIPv4: '203.0.113.11' })
        .mockResolvedValueOnce({ id: 789013, status: 'running', publicIPv4: '203.0.113.12' }),
    });
    const { service } = createService({
      hetzner,
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) }),
      machineIdFactory: () => machineIds.shift()!,
    });
    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    const staging = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });
    await service.register('registration-token', {
      machineId: primary.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });
    await service.register('registration-token', {
      machineId: staging.machineId,
      hetznerServerId: 789012,
      publicIPv4: '203.0.113.11',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const recovered = await service.recover({ clerkUserId: 'user_123', runtimeSlot: 'staging' });

    expect(recovered.oldMachineId).toBe(staging.machineId);
    expect(recovered.runtimeSlot).toBe('staging');
    expect(vi.mocked(hetzner.createServer).mock.calls[2][0].labels).toMatchObject({
      runtime_slot: 'staging',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toMatchObject({
      machineId: primary.machineId,
      status: 'running',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'staging')).resolves.toMatchObject({
      machineId: '7fe6cb68-738b-46a4-a338-f5fb74ac9123',
      runtimeSlot: 'staging',
      status: 'recovering',
    });
  });

  it('queues failed old-server cleanup after recovery and retries it during reconciliation', async () => {
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
    ];
    const deleteServer = vi.fn()
      .mockRejectedValueOnce(new Error('hetzner timeout'))
      .mockResolvedValueOnce(undefined);
    const { service } = createService({
      hetzner: createMockHetznerClient({
        createServer: vi
          .fn()
          .mockResolvedValueOnce({
            id: 123456,
            status: 'running',
            publicIPv4: '203.0.113.10',
          })
          .mockResolvedValueOnce({
            id: 789012,
            status: 'running',
            publicIPv4: '203.0.113.11',
          }),
        deleteServer,
      }),
      systemStore: createMockCustomerVpsSystemStore({
        hasDbLatest: vi.fn().mockResolvedValue(true),
      }),
      machineIdFactory: () => machineIds.shift()!,
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await service.recover({ clerkUserId: 'user_123' });

    const queued = await listPendingProviderDeletions(db, '2026-04-26T12:00:00.000Z', 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      providerServerId: 123456,
      reason: 'recover_old_server',
      machineId: provisioned.machineId,
      handle: 'alice',
    });

    await service.reconcileProvisioning();

    expect(deleteServer).toHaveBeenCalledTimes(2);
    expect(await listPendingProviderDeletions(db, '2026-04-26T12:00:00.000Z', 10)).toHaveLength(0);
  });

  it('rejects concurrent recover calls before creating a second replacement server', async () => {
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      'aaaaaaaa-2538-4f9f-a10d-1be5920a7bf7',
    ];
    const { service, hetzner } = createService({
      systemStore: createMockCustomerVpsSystemStore({
        hasDbLatest: vi.fn().mockResolvedValue(true),
      }),
      machineIdFactory: () => machineIds.shift()!,
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const results = await Promise.allSettled([
      service.recover({ clerkUserId: 'user_123' }),
      service.recover({ clerkUserId: 'user_123' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        status: 409,
        code: 'invalid_state',
      }),
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
    expect(await getUserMachine(db, 'aaaaaaaa-2538-4f9f-a10d-1be5920a7bf7')).toBeUndefined();
  });

  it('deletes a replacement server when recovery cannot record it in the DB', async () => {
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
    ];
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const createServer = vi
      .fn()
      .mockResolvedValueOnce({
        id: 123456,
        status: 'running',
        publicIPv4: '203.0.113.10',
      })
      .mockImplementationOnce(async () => {
        await db.destroy();
        return {
          id: 789012,
          status: 'running',
          publicIPv4: '203.0.113.11',
        };
      });
    const { service } = createService({
      hetzner: createMockHetznerClient({ createServer, deleteServer }),
      systemStore: createMockCustomerVpsSystemStore({
        hasDbLatest: vi.fn().mockResolvedValue(true),
      }),
      machineIdFactory: () => machineIds.shift()!,
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(service.recover({ clerkUserId: 'user_123' })).rejects.toMatchObject({
      status: 500,
      code: 'provider_unavailable',
    });

    expect(deleteServer).toHaveBeenCalledWith(789012);
    expect(deleteServer).not.toHaveBeenCalledWith(123456);
  });

  it('soft-deletes the DB row before deleting the Hetzner server', async () => {
    let deletedAtDuringProviderDelete: string | null | undefined;
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        deleteServer: vi.fn().mockImplementation(async () => {
          deletedAtDuringProviderDelete = (await getUserMachine(db, '9f05824c-8d0a-4d83-9cb4-b312d43ff112'))?.deletedAt;
        }),
      }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await service.delete(provisioned.machineId);

    expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
    expect(deletedAtDuringProviderDelete).toBe('2026-04-26T12:00:00.000Z');
  });

  it('claims a VPS delete only once', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const first = await claimUserMachineDelete(db, provisioned.machineId, '2026-04-26T12:00:00.000Z');
    const second = await claimUserMachineDelete(db, provisioned.machineId, '2026-04-26T12:01:00.000Z');

    expect(first).toMatchObject({
      machineId: provisioned.machineId,
      status: 'deleted',
      deletedAt: '2026-04-26T12:00:00.000Z',
    });
    expect(second).toBeUndefined();
    expect((await getUserMachine(db, provisioned.machineId))?.deletedAt).toBe('2026-04-26T12:00:00.000Z');
  });

  it('returns deleted when Hetzner cleanup fails after the DB soft-delete', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        deleteServer: vi.fn().mockRejectedValue(new Error('hetzner timeout')),
      }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(service.delete(provisioned.machineId)).resolves.toEqual({
      deleted: true,
      machineId: provisioned.machineId,
      status: 'deleted',
    });
    expect((await getUserMachine(db, provisioned.machineId))?.deletedAt).toBe('2026-04-26T12:00:00.000Z');
    expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
    expect(errorSpy).toHaveBeenCalledWith('[customer-vps] delete server cleanup failed: hetzner timeout');
    errorSpy.mockRestore();
  });

  it('sends channel deploy targets to the VPS system updater endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'stable',
    });

    try {
      await expect(service.deploy({ channel: 'dev' })).resolves.toMatchObject({ triggered: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://203.0.113.10:443/api/system/update',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ channel: 'dev' }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('only deploys to the requested VPS handle when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '9f05824c-8d0a-4d83-9cb4-b312d43ff113',
    ];
    const { service } = createService({
      machineIdFactory: () => machineIds.shift() ?? '9f05824c-8d0a-4d83-9cb4-b312d43ff114',
    });
    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: primary.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'stable',
    });
    const staging = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });
    await service.register('registration-token', {
      machineId: staging.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.11',
      imageVersion: 'stable',
    });

    try {
      await expect(service.deploy({ version: 'v082-onboarding-test', handle: 'alice-staging' }))
        .resolves.toMatchObject({ triggered: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://203.0.113.11:443/api/system/update',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ version: 'v082-onboarding-test' }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('queues failed delete cleanup and retries it during reconciliation', async () => {
    const deleteServer = vi.fn()
      .mockRejectedValueOnce(new Error('hetzner timeout'))
      .mockResolvedValueOnce(undefined);
    const { service } = createService({
      hetzner: createMockHetznerClient({ deleteServer }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await service.delete(provisioned.machineId);

    const queued = await listPendingProviderDeletions(db, '2026-04-26T12:00:00.000Z', 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      providerServerId: 123456,
      reason: 'delete',
      machineId: provisioned.machineId,
      handle: 'alice',
    });

    await service.reconcileProvisioning();

    expect(deleteServer).toHaveBeenCalledTimes(2);
    expect(await listPendingProviderDeletions(db, '2026-04-26T12:00:00.000Z', 10)).toHaveLength(0);
  });

  it('reconciles stale resizing machines even when other stale rows fill the batch', async () => {
    const serverReads = new Map<number, number>();
    const getServer = vi.fn(async (serverId: number) => {
      if (serverId !== 222222) return null;
      const readCount = serverReads.get(serverId) ?? 0;
      serverReads.set(serverId, readCount + 1);
      return readCount === 0
        ? { id: serverId, status: 'off', serverType: 'cpx32', publicIPv4: '203.0.113.20' }
        : { id: serverId, status: 'running', serverType: 'cpx32', publicIPv4: '203.0.113.20' };
    });
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'bd30b7f2-68bb-4aa7-9c15-8be106a83f9f',
    ];
    const { service, hetzner } = createService({
      config: createTestConfig({ reconciliationBatchSize: 1 }),
      hetzner: createMockHetznerClient({ getServer }),
      machineIdFactory: () => machineIds.shift()!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        maxRuntimeSlots: 2,
        includedRuntimeSlots: 2,
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const staleProvisioning = await service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      serverType: 'cpx22',
    });
    const resizing = await service.provision({
      clerkUserId: 'user_123',
      handle: 'alice-staging',
      runtimeSlot: 'staging',
      serverType: 'cpx22',
    });
    await updateUserMachine(db, staleProvisioning.machineId, {
      hetznerServerId: null,
      provisionedAt: '2026-04-26T10:00:00.000Z',
    });
    await updateUserMachine(db, resizing.machineId, {
      status: 'running',
      hetznerServerId: 222222,
      publicIPv4: '203.0.113.20',
      serverType: 'cpx22',
    });
    const claimed = await claimRunningUserMachineResize(
      db,
      resizing.machineId,
      222222,
      '2026-04-26T10:00:00.000Z',
      'cpx32',
    );
    expect(claimed?.status).toBe('resizing');

    const result = await service.reconcileProvisioning();

    expect(result).toMatchObject({ checked: 2, failed: 1, running: 1 });
    expect(hetzner.powerOnServer).toHaveBeenCalledWith(222222);
    await expect(getUserMachine(db, resizing.machineId)).resolves.toMatchObject({
      status: 'running',
      serverType: 'cpx32',
      resizeStartedAt: null,
      resizeTargetServerType: null,
    });
  });

  it('reconciles stale resizing machines back to running from provider state', async () => {
    const getServer = vi.fn()
      .mockResolvedValueOnce({
        id: 123456,
        status: 'off',
        serverType: 'cpx32',
        publicIPv4: '203.0.113.10',
      })
      .mockResolvedValueOnce({
        id: 123456,
        status: 'running',
        serverType: 'cpx32',
        publicIPv4: '203.0.113.10',
        publicIPv6: '2001:db8::/64',
      })
      .mockResolvedValueOnce({
        id: 123456,
        status: 'running',
        serverType: 'cpx32',
        publicIPv4: '203.0.113.10',
        publicIPv6: '2001:db8::/64',
      });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });
    const claimed = await claimRunningUserMachineResize(
      db,
      provisioned.machineId,
      123456,
      '2026-04-26T10:00:00.000Z',
      'cpx32',
    );
    expect(claimed?.status).toBe('resizing');

    const result = await service.reconcileProvisioning();

    expect(result).toMatchObject({ checked: 1, failed: 0, running: 1 });
    expect(hetzner.powerOnServer).toHaveBeenCalledWith(123456);
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      status: 'running',
      serverType: 'cpx32',
      resizeStartedAt: null,
      resizeTargetServerType: null,
      publicIPv4: '203.0.113.10',
      publicIPv6: '2001:db8::/64',
    });
  });

  it('continues stale resize reconciliation when a provider refresh fails after poweron', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serverReads = new Map<number, number>();
    const getServer = vi.fn(async (serverId: number) => {
      const readCount = serverReads.get(serverId) ?? 0;
      serverReads.set(serverId, readCount + 1);
      if (serverId === 123456) {
        if (readCount === 0) {
          return {
            id: serverId,
            status: 'off',
            serverType: 'cpx32',
            publicIPv4: '203.0.113.10',
          };
        }
        if (readCount === 1) {
          return {
            id: serverId,
            status: 'running',
            serverType: 'cpx32',
            publicIPv4: '203.0.113.10',
          };
        }
        throw new Error('transient provider refresh failure');
      }
      return {
        id: serverId,
        status: 'running',
        serverType: 'cpx32',
        publicIPv4: '203.0.113.20',
      };
    });
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'bd30b7f2-68bb-4aa7-9c15-8be106a83f9f',
    ];
    const { service } = createService({
      hetzner: createMockHetznerClient({ getServer }),
      machineIdFactory: () => machineIds.shift()!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        maxRuntimeSlots: 2,
        includedRuntimeSlots: 2,
        allowedServerTypes: ['cpx22', 'cpx32'],
        defaultServerType: 'cpx32',
      })),
    });
    const first = await service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      serverType: 'cpx22',
    });
    const second = await service.provision({
      clerkUserId: 'user_123',
      handle: 'alice-staging',
      runtimeSlot: 'staging',
      serverType: 'cpx22',
    });
    await updateUserMachine(db, first.machineId, {
      status: 'running',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      serverType: 'cpx22',
    });
    await updateUserMachine(db, second.machineId, {
      status: 'running',
      hetznerServerId: 222222,
      publicIPv4: '203.0.113.20',
      serverType: 'cpx22',
    });
    await claimRunningUserMachineResize(db, first.machineId, 123456, '2026-04-26T10:00:00.000Z', 'cpx32');
    await claimRunningUserMachineResize(db, second.machineId, 222222, '2026-04-26T10:00:00.000Z', 'cpx32');

    const result = await service.reconcileProvisioning();

    expect(result).toMatchObject({ checked: 2, failed: 0, running: 1 });
    await expect(getUserMachine(db, first.machineId)).resolves.toMatchObject({
      status: 'resizing',
      serverType: 'cpx22',
      resizeTargetServerType: 'cpx32',
    });
    await expect(getUserMachine(db, second.machineId)).resolves.toMatchObject({
      status: 'running',
      serverType: 'cpx32',
      resizeStartedAt: null,
      resizeTargetServerType: null,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '[customer-vps] resize reconcile server refresh failed machineId=9f05824c-8d0a-4d83-9cb4-b312d43ff112: transient provider refresh failure',
    );
    errorSpy.mockRestore();
  });

  it('surfaces stale resizing machines that never reached the target server type', async () => {
    const getServer = vi.fn()
      .mockResolvedValueOnce({
        id: 123456,
        status: 'off',
        serverType: 'cpx22',
        publicIPv4: '203.0.113.10',
      })
      .mockResolvedValueOnce({
        id: 123456,
        status: 'running',
        serverType: 'cpx22',
        publicIPv4: '203.0.113.10',
        publicIPv6: '2001:db8::/64',
      })
      .mockResolvedValueOnce({
        id: 123456,
        status: 'running',
        serverType: 'cpx22',
        publicIPv4: '203.0.113.10',
        publicIPv6: '2001:db8::/64',
      });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({ getServer }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx22' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });
    const claimed = await claimRunningUserMachineResize(
      db,
      provisioned.machineId,
      123456,
      '2026-04-26T10:00:00.000Z',
      'cpx32',
    );
    expect(claimed?.status).toBe('resizing');

    const result = await service.reconcileProvisioning();

    expect(result).toMatchObject({ checked: 1, failed: 1, running: 0 });
    expect(hetzner.powerOnServer).toHaveBeenCalledWith(123456);
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({
      status: 'running',
      serverType: 'cpx22',
      failureCode: 'resize_interrupted',
      failureAt: '2026-04-26T12:00:00.000Z',
      resizeStartedAt: null,
      resizeTargetServerType: null,
      publicIPv4: '203.0.113.10',
      publicIPv6: '2001:db8::/64',
    });
  });

  it('cleans up stale provider servers labeled for a machine that never recorded a Hetzner ID', async () => {
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const listServersByLabel = vi.fn().mockResolvedValue([
      { id: 999999, status: 'running', publicIPv4: '203.0.113.99' },
    ]);
    const { service } = createService({
      hetzner: createMockHetznerClient({ deleteServer, listServersByLabel }),
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await updateUserMachine(db, provisioned.machineId, {
      hetznerServerId: null,
      publicIPv4: null,
      publicIPv6: null,
      provisionedAt: '2026-04-26T10:00:00.000Z',
    });

    const result = await service.reconcileProvisioning();

    expect(result.failed).toBe(1);
    expect(listServersByLabel).toHaveBeenCalledWith(`machine_id=${provisioned.machineId}`);
    expect(deleteServer).toHaveBeenCalledWith(999999);
  });

  it('can provision the same Clerk user after a soft-deleted VPS row', async () => {
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => machineIds.shift()!,
    });
    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.delete(first.machineId);

    const second = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(second).toEqual({
      machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      status: 'provisioning',
      etaSeconds: 90,
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
    expect((await getUserMachine(db, first.machineId))?.deletedAt).toBe('2026-04-26T12:00:00.000Z');
    expect((await getUserMachine(db, second.machineId))?.deletedAt).toBeNull();
  });

  it('documents first-customer rollout checks and recovery expectations', () => {
    const quickstart = readFileSync('specs/070-vps-per-user/quickstart.md', 'utf8');

    expect(quickstart).toContain('First-Customer Rollout Checklist');
    expect(quickstart).toContain('Quota ceiling');
    expect(quickstart).toContain('Backup observation');
    expect(quickstart).toContain('Rollback');
    expect(quickstart).toContain('Non-production smoke commands');
  });

  it('publishes VPS-per-user deployment docs through the docs navigation', () => {
    const meta = JSON.parse(readFileSync('www/content/docs/developer/deployment/meta.json', 'utf8')) as { pages: string[] };
    const page = readFileSync('www/content/docs/developer/deployment/vps-per-user.mdx', 'utf8');

    expect(meta.pages).toContain('vps-per-user');
    expect(page).toContain('## Production Scope');
    expect(page).toContain('## Backup Retention');
    expect(page).toContain('## Manual Recovery');
    expect(page).toContain('## Rollback');
  });
});
