import { describe, it, expect, vi } from 'vitest';
import { getUserMachine, listPendingProviderDeletions, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestConfig, activeEntitlement, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
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
      accessClerkUserIds: ['user_456'],
    });
    const repeated = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
      accessClerkUserIds: ['user_789'],
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
    // The customer primary is authorized at request, claim, and provider-mutation
    // boundaries. Operator preview calls remain outside customer billing checks.
    expect(resolveBillingEntitlement).toHaveBeenCalledTimes(3);
    await expect(getUserMachine(db, preview.machineId)).resolves.toMatchObject({
      provisioningClass: 'preview',
      accessClerkUserIds: ['user_789'],
    });
  });
  it('keeps operator preview creation outside customer billing authorization', async () => {
    const resolveBillingEntitlement = vi.fn().mockResolvedValue(null);
    const { service, hetzner } = createService({
      config: createTestConfig({ previewProvisioningLimit: 1 }),
      resolveBillingEntitlement,
    });

    const preview = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-899',
      runtimeSlot: 'pr-899',
    });
    expect(preview).toMatchObject({ status: 'provisioning' });
    expect(hetzner.createServer).toHaveBeenCalledOnce();
    expect(resolveBillingEntitlement).not.toHaveBeenCalled();
    await expect(getUserMachine(db, preview.machineId)).resolves.toMatchObject({
      handle: 'pr-899', provisioningClass: 'preview',
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
  it('requires an exact subscription even for customer-provisioned preview-shaped slots', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
      resolveBillingEntitlement: vi.fn(async (_billingDb, _clerkUserId, runtimeSlot) =>
        runtimeSlot === 'pr-897' ? activeEntitlement({ maxRuntimeSlots: 1 }) : null),
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
    let nextProviderId = 123455;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
      '188d9ce1-395d-4d4c-a7b7-22754c3ab991',
    ];
    const createServer = vi.fn(async () => ({
      id: ++nextProviderId,
      status: 'running',
      publicIPv4: `203.0.113.${nextProviderId - 123400}`,
    }));
    const { service, hetzner } = createService({
      config: createTestConfig({ previewProvisioningLimit: 1 }),
      machineIdFactory: () => ids[nextId++] ?? ids[2]!,
      hetzner: createMockHetznerClient({ createServer }),
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

});
