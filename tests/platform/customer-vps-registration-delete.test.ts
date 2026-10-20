import { describe, it, expect, vi } from 'vitest';
import { claimUserMachineDelete, completeUserMachineRegistration, getUserMachine, listPendingProviderDeletions, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { buildCustomerVpsR2Key, buildVpsMeta, createCustomerVpsSystemStore } from '../../packages/platform/src/customer-vps-r2.js';
import { activeEntitlement, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
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
  it('distinguishes a completed registration from other invalid states', async () => {
    const { service } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    const registration = {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    };

    await service.register('registration-token', registration);

    await expect(service.register('registration-token', registration)).rejects.toMatchObject({
      status: 409,
      code: 'already_registered',
    });
  });
  it('completes registration after an already-authorized create when entitlement later changes', async () => {
    const resolveBillingEntitlement = vi.fn().mockResolvedValue(activeEntitlement());
    const { service } = createService({ resolveBillingEntitlement });
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    resolveBillingEntitlement.mockResolvedValue(null);

    await expect(service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
      healthy: true,
    })).resolves.toMatchObject({ registered: true, status: 'running' });
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

});
