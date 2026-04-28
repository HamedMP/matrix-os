import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  claimUserMachineDelete,
  completeUserMachineRegistration,
  getActiveUserMachineByClerkId,
  getUserMachine,
  listPendingProviderDeletions,
  updateUserMachine,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
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
    await destroyTestPlatformDb(db);
  });

  function createService(overrides: Parameters<typeof createCustomerVpsService>[0] = {} as any) {
    const hetzner = createMockHetznerClient(overrides.hetzner);
    const systemStore = createMockCustomerVpsSystemStore(overrides.systemStore);
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_PORT: '9000',
        PLATFORM_SECRET: 'platform-secret',
        HETZNER_API_TOKEN: 'token',
        R2_BUCKET: 'matrixos-sync',
      }),
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

  it('provisions a user machine idempotently by clerkUserId', async () => {
    const { service, hetzner } = createService();

    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    const second = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(first).toEqual({ machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', status: 'provisioning', etaSeconds: 90 });
    expect(second).toEqual(first);
    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.hetznerServerId).toBe(123456);
    expect(row?.registrationTokenHash).toBe(hashRegistrationToken('registration-token'));
  });

  it('templates the platform verification token into provisioned customer hosts', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const expected = createHmac('sha256', 'platform-secret').update('alice').digest('hex');
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain(`UPGRADE_TOKEN=${expected}`);
    expect(createInput?.userData).toContain(`MATRIX_CODE_PROXY_TOKEN=${expected}`);
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

  it('validates R2 latest pointers without accepting paths or URLs', () => {
    expect(validateDbLatestPointer('system/db/snapshots/2026-04-26T1800Z.dump')).toBe(true);
    expect(validateDbLatestPointer('../system/db/snapshots/2026-04-26T1800Z.dump')).toBe(false);
    expect(validateDbLatestPointer('https://example.com/snapshot.dump')).toBe(false);
    expect(validateDbLatestPointer('system/db/snapshots/not-a-date.dump')).toBe(false);
  });

  it('writes VPS metadata to the scoped user R2 key', async () => {
    const writes: Array<{ key: string; body: string; signal?: AbortSignal }> = [];
    const reads: AbortSignal[] = [];
    const store = createCustomerVpsSystemStore({
      r2PrefixRoot: 'matrixos-sync',
      r2: {
        async putObject(key, body, options) {
          writes.push({ key, body: String(body), signal: options?.signal });
          return {};
        },
        async getObject(_key, options) {
          if (options?.signal) reads.push(options.signal);
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
    expect(reads[0]).toBeInstanceOf(AbortSignal);
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
      status: 'recovering',
    });
    expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
    expect(
      vi.mocked(hetzner.createServer).mock.invocationCallOrder[1],
    ).toBeLessThan(vi.mocked(hetzner.deleteServer).mock.invocationCallOrder[0]);
    const secondCreate = vi.mocked(hetzner.createServer).mock.calls[1][0];
    expect(secondCreate.name).toBe('matrix-alice-f973bb98');
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

  it('documents first-customer rollout checks and recovery expectations', () => {
    const quickstart = readFileSync('specs/070-vps-per-user/quickstart.md', 'utf8');

    expect(quickstart).toContain('First-Customer Rollout Checklist');
    expect(quickstart).toContain('Quota ceiling');
    expect(quickstart).toContain('Backup observation');
    expect(quickstart).toContain('Rollback');
    expect(quickstart).toContain('Non-production smoke commands');
  });

  it('publishes VPS-per-user deployment docs through the docs navigation', () => {
    const meta = JSON.parse(readFileSync('www/content/docs/deployment/meta.json', 'utf8')) as { pages: string[] };
    const page = readFileSync('www/content/docs/deployment/vps-per-user.mdx', 'utf8');

    expect(meta.pages).toContain('vps-per-user');
    expect(page).toContain('## Phase 1 Scope');
    expect(page).toContain('## Backup Retention');
    expect(page).toContain('## Manual Recovery');
    expect(page).toContain('## Rollback');
  });
});
