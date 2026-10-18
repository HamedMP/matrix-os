import { describe, it, expect, vi } from 'vitest';
import { claimRunningUserMachineResize, getUserMachine, insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestConfig, activeEntitlement, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
  it('suspends a running machine with graceful-shutdown fallback and retains its data', async () => {
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff130',
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      status: 'running',
      imageVersion: 'v1',
      provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        shutdownServer: vi.fn().mockRejectedValue(new Error('graceful shutdown unavailable')),
        getServer: vi.fn()
          .mockResolvedValueOnce({
            id: 123456,
            status: 'running',
            serverType: 'cpx22',
            publicIPv4: '203.0.113.10',
            publicIPv6: null,
          })
          .mockResolvedValue({
            id: 123456,
            status: 'off',
            serverType: 'cpx22',
            publicIPv4: '203.0.113.10',
            publicIPv6: null,
          }),
      }),
    });

    await expect(service.suspendForBilling('9f05824c-8d0a-4d83-9cb4-b312d43ff130')).resolves.toBeUndefined();

    expect(hetzner.shutdownServer).toHaveBeenCalledWith(123456);
    expect(hetzner.powerOffServer).toHaveBeenCalledWith(123456);
    await expect(getUserMachine(db, '9f05824c-8d0a-4d83-9cb4-b312d43ff130')).resolves.toMatchObject({
      status: 'suspended',
      deletedAt: null,
      publicIPv4: '203.0.113.10',
    });
  });
  it('does not start a billing suspension after its durable action is superseded', async () => {
    const machineId = '9f05824c-8d0a-4d83-9cb4-b312d43ff133';
    await insertUserMachine(db, {
      machineId, clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary',
      provisioningClass: 'customer', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const { service, hetzner } = createService();
    const shouldContinue = vi.fn().mockResolvedValue(false);

    await expect(service.suspendForBilling(machineId, shouldContinue)).resolves.toBeUndefined();

    expect(shouldContinue).toHaveBeenCalledOnce();
    expect(hetzner.shutdownServer).not.toHaveBeenCalled();
    expect(hetzner.powerOffServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'running' });
  });
  it('suspends a delinquent machine left resuming by a superseded action', async () => {
    const machineId = '9f05824c-8d0a-4d83-9cb4-b312d43ff135';
    await insertUserMachine(db, {
      machineId, clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary',
      provisioningClass: 'customer', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'resuming', imageVersion: 'v1', provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        getServer: vi.fn()
          .mockResolvedValueOnce({
            id: 123456, status: 'running', serverType: 'cpx22',
            publicIPv4: '203.0.113.10', publicIPv6: null,
          })
          .mockResolvedValue({
            id: 123456, status: 'off', serverType: 'cpx22',
            publicIPv4: '203.0.113.10', publicIPv6: null,
          }),
      }),
    });

    await expect(service.suspendForBilling(machineId)).resolves.toBeUndefined();

    expect(hetzner.shutdownServer).toHaveBeenCalledWith(123456);
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'suspended' });
  });
  it('resumes a suspended machine only after provider and runtime health recover', async () => {
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff131',
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      status: 'suspended',
      imageVersion: 'v1',
      provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        getServer: vi.fn()
          .mockResolvedValueOnce({
            id: 123456,
            status: 'off',
            serverType: 'cpx22',
            publicIPv4: '203.0.113.10',
            publicIPv6: null,
          })
          .mockResolvedValue({
            id: 123456,
            status: 'running',
            serverType: 'cpx22',
            publicIPv4: '203.0.113.10',
            publicIPv6: null,
          }),
      }),
    });

    try {
      await expect(service.resumeForBilling('9f05824c-8d0a-4d83-9cb4-b312d43ff131')).resolves.toBeUndefined();
      expect(hetzner.powerOnServer).toHaveBeenCalledWith(123456);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://203.0.113.10:443/health',
        expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
      );
      await expect(getUserMachine(db, '9f05824c-8d0a-4d83-9cb4-b312d43ff131')).resolves.toMatchObject({
        status: 'running',
        deletedAt: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not start a billing resume after its durable action is superseded', async () => {
    const machineId = '9f05824c-8d0a-4d83-9cb4-b312d43ff134';
    await insertUserMachine(db, {
      machineId, clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary',
      provisioningClass: 'customer', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'suspended', imageVersion: 'v1', provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const { service, hetzner } = createService();
    const shouldContinue = vi.fn().mockResolvedValue(false);

    await expect(service.resumeForBilling(machineId, shouldContinue)).resolves.toBeUndefined();

    expect(shouldContinue).toHaveBeenCalledOnce();
    expect(hetzner.powerOnServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'suspended' });
  });
  it('recovers a paid machine left suspending after an interrupted shutdown', async () => {
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff132',
      clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary', provisioningClass: 'customer',
      hetznerServerId: 123456, publicIPv4: '203.0.113.10', status: 'suspending',
      imageVersion: 'v1', provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        getServer: vi.fn()
          .mockResolvedValueOnce({
            id: 123456, status: 'off', serverType: 'cpx22', publicIPv4: '203.0.113.10', publicIPv6: null,
          })
          .mockResolvedValue({
            id: 123456, status: 'running', serverType: 'cpx22', publicIPv4: '203.0.113.10', publicIPv6: null,
          }),
      }),
    });

    try {
      await expect(service.resumeForBilling('9f05824c-8d0a-4d83-9cb4-b312d43ff132')).resolves.toBeUndefined();
      expect(hetzner.powerOnServer).toHaveBeenCalledWith(123456);
      await expect(getUserMachine(db, '9f05824c-8d0a-4d83-9cb4-b312d43ff132')).resolves.toMatchObject({
        status: 'running',
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

});
