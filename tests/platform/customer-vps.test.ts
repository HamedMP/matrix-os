import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDb,
  getActiveUserMachineByClerkId,
  getUserMachine,
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

describe('platform/customer-vps', () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'customer-vps-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createService(overrides: Parameters<typeof createCustomerVpsService>[0] = {} as any) {
    const hetzner = createMockHetznerClient(overrides.hetzner);
    const systemStore = createMockCustomerVpsSystemStore(overrides.systemStore);
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_PORT: '9000',
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
    const row = getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.hetznerServerId).toBe(123456);
    expect(row?.registrationTokenHash).toBe(hashRegistrationToken('registration-token'));
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

    const row = getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe('quota_exceeded');
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
    const row = getUserMachine(db, provisioned.machineId);
    expect(row?.status).toBe('running');
    expect(row?.registrationTokenHash).toBeNull();
    expect(row?.registrationTokenExpiresAt).toBeNull();
    expect(systemStore.writtenMeta).toHaveLength(1);
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

    expect(getUserMachine(db, provisioned.machineId)?.status).toBe('provisioning');
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

    const row = getUserMachine(db, provisioned.machineId)!;
    expect(buildVpsMeta(row, '2026-04-26T12:05:00.000Z')).toMatchObject({
      version: 1,
      userId: 'user_123',
      machineId: provisioned.machineId,
      status: 'running',
      publicIPv4: '203.0.113.10',
    });
  });

  it('validates R2 latest pointers without accepting paths or URLs', () => {
    expect(validateDbLatestPointer('system/db/snapshots/2026-04-26T1800Z.sql.gz')).toBe(true);
    expect(validateDbLatestPointer('../system/db/snapshots/2026-04-26T1800Z.sql.gz')).toBe(false);
    expect(validateDbLatestPointer('https://example.com/snapshot.sql.gz')).toBe(false);
    expect(validateDbLatestPointer('system/db/snapshots/not-a-date.sql.gz')).toBe(false);
  });

  it('writes VPS metadata to the scoped user R2 key', async () => {
    const writes: Array<{ key: string; body: string }> = [];
    const store = createCustomerVpsSystemStore({
      r2PrefixRoot: 'matrixos-sync',
      r2: {
        async putObject(key, body) {
          writes.push({ key, body: String(body) });
          return {};
        },
        async getObject() {
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
    expect(JSON.parse(writes[0].body)).toMatchObject({
      userId: 'user_123',
      machineId: provisioned.machineId,
      status: 'running',
    });
    await expect(store.hasDbLatest('user_123')).resolves.toBe(false);
    expect(buildCustomerVpsR2Key('matrixos-sync/', 'user_123', 'system/db/latest')).toBe(
      'matrixos-sync/user_123/system/db/latest',
    );
    expect(() => buildCustomerVpsR2Key('matrixos-sync', 'user_123', '../system/db/latest')).toThrow(
      'Invalid customer VPS system key',
    );
  });
});
