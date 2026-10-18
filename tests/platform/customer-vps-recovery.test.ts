import { describe, it, expect, vi } from 'vitest';
import { getActiveUserMachineByClerkId, getUserMachine, listPendingProviderDeletions, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestConfig, activeEntitlement, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
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
  it('keeps the old server until the replacement from R2 preflight registers healthy', async () => {
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
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice', location: 'hil' });
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
    expect(hetzner.deleteServer).not.toHaveBeenCalledWith(123456);
    await service.register('registration-token', {
      machineId: recovered.machineId,
      hetznerServerId: 789012,
      publicIPv4: '203.0.113.11',
      imageVersion: 'stable',
      bundleSha256: '0'.repeat(64),
      healthy: true,
    });
    expect(hetzner.deleteServer).not.toHaveBeenCalledWith(123456);
    await service.reconcileProvisioning();
    expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
    expect(
      vi.mocked(hetzner.createServer).mock.invocationCallOrder[1],
    ).toBeLessThan(vi.mocked(hetzner.deleteServer).mock.invocationCallOrder[0]);
    const secondCreate = vi.mocked(hetzner.createServer).mock.calls[1][0];
    expect(secondCreate.name).toBe('matrix-alice-f973bb98');
    expect(secondCreate).toMatchObject({
      location: 'hil',
      labels: { runtime_slot: 'primary' },
    });
    const row = (await getUserMachine(db, recovered.machineId))!;
    expect(row).toMatchObject({
      clerkUserId: 'user_123',
      handle: 'alice',
      status: 'running',
      hetznerServerId: 789012,
      publicIPv4: '203.0.113.11',
      location: 'hil',
    });
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toBeUndefined();
  });
  it('does not create a recovery replacement when snapshot mode cannot prove the target digest', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId, hetznerServerId: 123456,
      publicIPv4: '203.0.113.10', imageVersion: 'matrix-os-host-2026.04.26-1',
    });
    const enabled = loadCustomerVpsConfig({
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', PLATFORM_SECRET: 'platform-secret',
    }).goldenSnapshots;
    const { service: recoveryService, hetzner } = createService({
      config: createTestConfig({ goldenSnapshots: enabled }),
      machineIdFactory: () => 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) }),
    });

    await expect(recoveryService.recover({ clerkUserId: 'user_123' })).rejects.toMatchObject({
      status: 503,
      code: 'provider_unavailable',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, provisioned.machineId)).resolves.toMatchObject({ status: 'running' });
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
    let currentNow = new Date('2026-04-26T12:00:00.000Z');
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
      now: () => currentNow,
    });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    const recovered = await service.recover({ clerkUserId: 'user_123' });
    await service.register('registration-token', {
      machineId: recovered.machineId,
      hetznerServerId: 789012,
      publicIPv4: '203.0.113.11',
      imageVersion: 'stable',
      bundleSha256: '0'.repeat(64),
      healthy: true,
    });

    const queued = await listPendingProviderDeletions(db, '2026-04-26T12:00:00.000Z', 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      providerServerId: 123456,
      reason: 'recover_old_server',
      machineId: recovered.machineId,
      handle: 'alice',
    });

    await service.reconcileProvisioning();
    currentNow = new Date('2026-04-26T12:15:00.000Z');
    await service.reconcileProvisioning();

    expect(deleteServer).toHaveBeenCalledTimes(2);
    expect(await listPendingProviderDeletions(db, currentNow.toISOString(), 10)).toHaveLength(0);
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

});
