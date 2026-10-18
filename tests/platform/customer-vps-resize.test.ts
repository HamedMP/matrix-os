import { describe, it, expect, vi } from 'vitest';
import { getUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { createMockHetznerClient } from './customer-vps-fixtures.js';
import { activeEntitlement, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
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

});
