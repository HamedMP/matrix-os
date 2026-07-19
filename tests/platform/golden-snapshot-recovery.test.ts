import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveUserMachineByClerkId, getUserMachine, insertUserMachine, upsertHostBundleRelease, type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import {
  advanceGoldenSnapshot, claimGoldenSnapshotBuild, enqueueGoldenSnapshotBuild, markGoldenSnapshotReady,
  reconcileExpiredGoldenSnapshotLeases, recordGoldenSnapshotProviderImage,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('golden snapshot recovery', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await upsertHostBundleRelease(db, {
      version: 'v2', gitCommit: '2222222', buildTime: '2026-07-02T00:00:00.000Z',
      bundleKey: 'system-bundles/v2/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '2'.repeat(64), size: 100, createdAt: '2026-07-02T00:00:00.000Z',
    });
    await insertUserMachine(db, {
      machineId: '30000000-0000-4000-8000-000000000010', clerkUserId: 'user_recover', handle: 'recover-me',
      runtimeSlot: 'primary', developerTools: [], status: 'running', imageVersion: 'v1', serverType: 'cpx22',
      hetznerServerId: 50, publicIPv4: '203.0.113.50', provisionedAt: '2026-07-01T00:00:00.000Z',
    });
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central', baseImage: 'ubuntu-24.04',
      baseGeneration: 'ubuntu-24.04-v1', bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000010',
      buildId: '20000000-0000-4000-8000-000000000010', now: '2026-07-02T01:00:00.000Z',
    });
    const claimed = await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-02T01:00:00.500Z', '2026-07-02T01:10:00.000Z', 5,
    );
    const fence = claimed!.leaseExpiresAt!;
    await advanceGoldenSnapshot(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, fence, 'candidate', 'building', '2026-07-02T01:00:01.000Z');
    await advanceGoldenSnapshot(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, fence, 'building', 'sanitizing', '2026-07-02T01:00:02.000Z');
    await advanceGoldenSnapshot(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, fence, 'sanitizing', 'validating', '2026-07-02T01:00:03.000Z');
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId, expectedLeaseExpiresAt: fence,
      providerImageId: 302, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-02T01:00:04.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'validation_boot', status: 'running', lease_expires_at: '2026-07-02T01:10:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await markGoldenSnapshotReady(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, {
      validationSummary: { exactBundle: true, healthy: true, freshActivation: true, uniqueMachineId: true, uniqueSshHostKey: true, forbiddenStateAbsent: true },
      expectedLeaseExpiresAt: '2026-07-02T01:10:00.000Z',
      now: '2026-07-02T01:00:05.000Z',
    });
  });
  afterEach(async () => destroyTestPlatformDb(db));

  it('leases the exact image for replacement infrastructure and releases it after durable adoption', async () => {
    const hetzner = createMockHetznerClient();
    const systemStore = createMockCustomerVpsSystemStore({ hasDbLatest: async () => true });
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      HETZNER_SERVER_TYPE: 'cpx32',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config, hetzner, systemStore,
      machineIdFactory: () => '30000000-0000-4000-8000-000000000011',
      tokenFactory: () => ({
        token: 'recovery-registration-token',
        hash: hashRegistrationToken('recovery-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    const recovery = await service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });

    expect(hetzner.createServer).toHaveBeenCalledWith(expect.objectContaining({ image: 302 }));
    const activeLease = await db.executor.selectFrom('golden_snapshot_leases').selectAll()
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000011').executeTakeFirstOrThrow();
    expect(activeLease.purpose).toBe('recover');
    expect(activeLease.released_at).toBeNull();

    await service.register('recovery-registration-token', {
      machineId: recovery.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'v2',
      bundleSha256: '2'.repeat(64),
      healthy: true,
    });

    const releasedLease = await db.executor.selectFrom('golden_snapshot_leases').selectAll()
      .where('machine_id', '=', recovery.machineId).executeTakeFirstOrThrow();
    expect(releasedLease.released_at).toBe('2026-07-03T00:00:00.000Z');
    expect(await getUserMachine(db, recovery.machineId)).toMatchObject({
      sourceSnapshotId: '10000000-0000-4000-8000-000000000010',
      sourceBaseGeneration: 'ubuntu-24.04-v1',
      targetBundleVersion: 'v2',
      targetBundleSha256: '2'.repeat(64),
      serverType: 'cpx22',
    });
  });

  it('releases an expired recovery lease whose intended machine row was never adopted', async () => {
    const orphanMachineId = '30000000-0000-4000-8000-000000000099';
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000099',
      snapshot_id: '10000000-0000-4000-8000-000000000010',
      machine_id: orphanMachineId,
      purpose: 'recover',
      target_bundle_version: 'v2',
      created_at: '2026-07-03T00:00:00.000Z',
      expires_at: '2026-07-03T00:01:00.000Z',
      released_at: null,
    }).execute();

    await expect(reconcileExpiredGoldenSnapshotLeases(db, '2026-07-03T00:02:00.000Z', 10)).resolves.toBe(1);
    await expect(db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', orphanMachineId).executeTakeFirstOrThrow()).resolves.toMatchObject({
      released_at: '2026-07-03T00:02:00.000Z',
    });
  });

  it('retains the old server until the replacement registers healthy', async () => {
    let resolveCreate!: (server: { id: number; status: string; publicIPv4: string }) => void;
    const createServer = vi.fn(() => new Promise<{ id: number; status: string; publicIPv4: string }>((resolve) => {
      resolveCreate = resolve;
    }));
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config, hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000017',
      tokenFactory: () => ({
        token: 'cutover-registration-token',
        hash: hashRegistrationToken('cutover-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    const recoveryPromise = service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });
    await vi.waitFor(() => expect(createServer).toHaveBeenCalledTimes(1));
    await expect(getActiveUserMachineByClerkId(db, 'user_recover', 'primary')).resolves.toMatchObject({
      machineId: '30000000-0000-4000-8000-000000000017',
      status: 'recovering',
      hetznerServerId: null,
      recoveryOldServerId: 50,
      recoveryEncryptedPayload: expect.any(String),
    });

    resolveCreate({ id: 123462, status: 'running', publicIPv4: '203.0.113.17' });
    await expect(recoveryPromise).resolves.toMatchObject({
      machineId: '30000000-0000-4000-8000-000000000017', status: 'recovering',
    });
    await expect(db.executor.selectFrom('provider_deletion_queue')
      .select(['provider_server_id', 'reason'])
      .where('provider_server_id', '=', 50)
      .executeTakeFirst()).resolves.toBeUndefined();
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000017'))
      .resolves.toMatchObject({ recoveryOldServerId: 50, recoveryEncryptedPayload: expect.any(String) });

    await service.register('cutover-registration-token', {
      machineId: '30000000-0000-4000-8000-000000000017',
      hetznerServerId: 123462, publicIPv4: '203.0.113.17', imageVersion: 'v2',
      bundleSha256: '2'.repeat(64), healthy: true,
    });
    await expect(db.executor.selectFrom('provider_deletion_queue')
      .select(['provider_server_id', 'reason'])
      .where('provider_server_id', '=', 50)
      .executeTakeFirst()).resolves.toEqual({
      provider_server_id: 50,
      reason: 'recover_old_server',
    });
  });

  it('reconciles an ambiguous recovery create response by exact replacement labels', async () => {
    const replacement = {
      id: 123463, status: 'running', publicIPv4: '203.0.113.18',
      labels: {
        app: 'matrix-os', clerk_user_id: 'user_recover', runtime_slot: 'primary',
        machine_id: '30000000-0000-4000-8000-000000000018', image_source: 'snapshot',
        snapshot_id: '10000000-0000-4000-8000-000000000010',
      },
    };
    const createServer = vi.fn().mockRejectedValue(new Error('response lost'));
    const listServersByLabel = vi.fn().mockResolvedValue([replacement]);
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS: '1000',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config,
      hetzner: createMockHetznerClient({ createServer, listServersByLabel, deleteServer }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000018',
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    await expect(service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(service.reconcileProvisioning()).resolves.toMatchObject({ checked: 1, failed: 0, running: 0 });
    expect(listServersByLabel).toHaveBeenCalledWith('machine_id=30000000-0000-4000-8000-000000000018');
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000018')).resolves.toMatchObject({
      status: 'recovering', hetznerServerId: 123463, recoveryOldServerId: 50,
      recoveryEncryptedPayload: expect.any(String),
      sourceSnapshotId: '10000000-0000-4000-8000-000000000010', targetBundleVersion: 'v2',
    });
    expect(deleteServer).not.toHaveBeenCalled();
  });

  it('restores the old VPS immediately after a definitive recovery create rejection', async () => {
    const createServer = vi.fn().mockRejectedValue(
      new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable'),
    );
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config, hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000019',
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    await expect(service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' }))
      .rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(getActiveUserMachineByClerkId(db, 'user_recover', 'primary')).resolves.toMatchObject({
      machineId: '30000000-0000-4000-8000-000000000010', status: 'running',
      hetznerServerId: 50, recoveryOldServerId: null, recoveryEncryptedPayload: null,
    });
    await expect(db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000019').executeTakeFirstOrThrow())
      .resolves.toMatchObject({ released_at: '2026-07-03T00:00:00.000Z' });
  });

  it('restores the old VPS after bounded reconciliation proves no replacement was adopted', async () => {
    const createServer = vi.fn().mockRejectedValue(new Error('response lost'));
    const listServersByLabel = vi.fn().mockResolvedValue([]);
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS: '1000',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config, hetzner: createMockHetznerClient({
        createServer,
        listServersByLabel,
        getServer: vi.fn().mockResolvedValue({
          id: 50, status: 'running', publicIPv4: '203.0.113.50', publicIPv6: null,
        }),
      }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000020',
      tokenFactory: () => ({
        token: 'expired-recovery-token', hash: hashRegistrationToken('expired-recovery-token'),
        expiresAt: '2026-07-02T23:59:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    await expect(service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(service.reconcileProvisioning()).resolves.toMatchObject({ running: 1 });
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000010')).resolves.toMatchObject({
      status: 'running', hetznerServerId: 50, publicIPv4: '203.0.113.50',
      recoveryOldServerId: null, recoveryEncryptedPayload: null,
    });
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000020')).resolves.toBeUndefined();
  });

  it('keeps an expired recovery lease while provider adoption remains ambiguous', async () => {
    const machineId = '30000000-0000-4000-8000-000000000019';
    await insertUserMachine(db, {
      machineId, clerkUserId: 'user_stuck_recovery', handle: 'stuck-recovery',
      runtimeSlot: 'primary', developerTools: [], status: 'recovering', imageVersion: 'v2',
      hetznerServerId: null, recoveryOldServerId: 519, recoveryEncryptedPayload: 'sealed-intent',
      provisionedAt: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000019',
      snapshot_id: '10000000-0000-4000-8000-000000000010',
      machine_id: machineId,
      purpose: 'recover',
      target_bundle_version: 'v2',
      created_at: '2026-07-03T00:00:00.000Z',
      expires_at: '2026-07-03T00:01:00.000Z',
      released_at: null,
    }).execute();

    await expect(reconcileExpiredGoldenSnapshotLeases(db, '2026-07-03T00:02:00.000Z', 10)).resolves.toBe(0);
    await expect(db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', machineId).executeTakeFirstOrThrow()).resolves.toMatchObject({
      released_at: null,
    });
  });

  it('keeps an expired recovery lease through registration and preserves snapshot provenance', async () => {
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config, hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000021',
      tokenFactory: () => ({
        token: 'delayed-registration-token', hash: hashRegistrationToken('delayed-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });
    const recovery = await service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });
    await expect(reconcileExpiredGoldenSnapshotLeases(db, '2026-07-03T00:11:00.000Z', 10)).resolves.toBe(0);

    await expect(service.register('delayed-registration-token', {
      machineId: recovery.machineId, hetznerServerId: 123456, publicIPv4: '203.0.113.21',
      imageVersion: 'v1', bundleSha256: '1'.repeat(64), healthy: true,
    })).rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(service.register('delayed-registration-token', {
      machineId: recovery.machineId, hetznerServerId: 123456, publicIPv4: '203.0.113.21',
      imageVersion: 'v2', bundleSha256: '2'.repeat(64), healthy: true,
    })).resolves.toMatchObject({ registered: true, status: 'running' });
    await expect(getUserMachine(db, recovery.machineId)).resolves.toMatchObject({
      sourceSnapshotId: '10000000-0000-4000-8000-000000000010',
      sourceBaseGeneration: 'ubuntu-24.04-v1', targetBundleVersion: 'v2',
      targetBundleSha256: '2'.repeat(64),
    });
    await expect(db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', recovery.machineId).executeTakeFirstOrThrow())
      .resolves.toMatchObject({ released_at: '2026-07-03T00:00:00.000Z' });
  });

  it('re-renders clean-image activation after a definite recovery clone rejection', async () => {
    const createServer = vi.fn()
      .mockRejectedValueOnce(new CustomerVpsError(500, 'snapshot_clone_rejected', 'Provisioning provider unavailable'))
      .mockResolvedValueOnce({ id: 123457, status: 'running', publicIPv4: '203.0.113.11' });
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config, hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000012',
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    await service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });
    expect(createServer).toHaveBeenNthCalledWith(1, expect.objectContaining({ image: 302 }));
    expect(createServer).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ image: expect.anything() }));
    expect(createServer.mock.calls[1]![0].userData).toContain('MATRIX_IMAGE_SOURCE=clean_image');
    expect(createServer.mock.calls[1]![0].userData).not.toContain('MATRIX_IMAGE_SOURCE=snapshot');
  });

  it('falls back to a clean image when an accepted recovery clone action fails', async () => {
    const createServer = vi.fn()
      .mockResolvedValueOnce({
        id: 123458, status: 'starting', publicIPv4: '203.0.113.12', createActionId: 9001,
      })
      .mockResolvedValueOnce({ id: 123459, status: 'running', publicIPv4: '203.0.113.13' });
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const service = createCustomerVpsService({
      db, config,
      hetzner: createMockHetznerClient({
        createServer,
        deleteServer,
        getAction: vi.fn().mockResolvedValue({ id: 9001, status: 'error', command: 'create_server' }),
        getServer: vi.fn().mockResolvedValue(null),
      }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000013',
      tokenFactory: () => ({
        token: 'fallback-registration-token',
        hash: hashRegistrationToken('fallback-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    const recovery = await service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });
    expect(createServer).toHaveBeenNthCalledWith(1, expect.objectContaining({ image: 302 }));
    expect(createServer).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ image: expect.anything() }));
    expect(createServer.mock.calls[1]![0].userData).toContain('MATRIX_IMAGE_SOURCE=clean_image');
    expect(deleteServer).toHaveBeenCalledWith(123458);
    await expect(service.register('fallback-registration-token', {
      machineId: recovery.machineId,
      hetznerServerId: 123459,
      publicIPv4: '203.0.113.13',
      imageVersion: 'v2',
      bundleSha256: '2'.repeat(64),
      healthy: true,
    })).resolves.toMatchObject({ registered: true, status: 'running' });
    expect(await getUserMachine(db, recovery.machineId)).toMatchObject({
      sourceSnapshotId: null,
      sourceBaseGeneration: null,
    });
  });

  it('persists a slow recovery create action for asynchronous reconciliation', async () => {
    let currentNow = new Date('2026-07-03T00:00:00.000Z');
    const server = {
      id: 123460, status: 'starting', publicIPv4: '203.0.113.14', createActionId: 9002,
    };
    const createServer = vi.fn().mockResolvedValue(server);
    const getAction = vi.fn().mockResolvedValue({ id: 9002, status: 'running', command: 'create_server' });
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS: '1000',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config,
      hetzner: createMockHetznerClient({ createServer, getAction, getServer: vi.fn().mockResolvedValue(server) }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000014',
      now: () => currentNow,
    });

    const recovery = await service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(await getUserMachine(db, recovery.machineId)).toMatchObject({
      status: 'recovering',
      recoveryCreateActionId: 9002,
      recoveryOldServerId: 50,
    });

    getAction.mockResolvedValue({ id: 9002, status: 'success', command: 'create_server' });
    currentNow = new Date('2026-07-03T00:02:00.000Z');
    await service.reconcileProvisioning();
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(await getUserMachine(db, recovery.machineId)).toMatchObject({
      status: 'recovering',
      recoveryCreateActionId: null,
      recoveryOldServerId: 50,
      recoveryEncryptedPayload: expect.any(String),
    });
    await expect(db.executor.selectFrom('provider_deletion_queue').select('provider_server_id')
      .where('provider_server_id', '=', 50).executeTakeFirst()).resolves.toBeUndefined();
  });

  it('reconciles an ambiguous clean fallback after a pending snapshot clone fails', async () => {
    let currentNow = new Date('2026-07-03T00:00:00.000Z');
    const createServer = vi.fn()
      .mockResolvedValueOnce({
        id: 123461, status: 'starting', publicIPv4: '203.0.113.15', createActionId: 9003,
      })
      .mockRejectedValueOnce(new Error('response lost'));
    const getAction = vi.fn().mockResolvedValue({ id: 9003, status: 'running', command: 'create_server' });
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100', GOLDEN_SNAPSHOT_REGION: 'eu-central',
      CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS: '1000',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config,
      hetzner: createMockHetznerClient({
        createServer, getAction, deleteServer,
        getServer: vi.fn(async (serverId: number) => serverId === 50
          ? { id: 50, status: 'running', publicIPv4: '203.0.113.50', publicIPv6: null }
          : null),
        listServersByLabel: vi.fn().mockResolvedValue([]),
      }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000015',
      now: () => currentNow,
    });

    const recovery = await service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });
    getAction.mockResolvedValue({ id: 9003, status: 'error', command: 'create_server' });
    currentNow = new Date('2026-07-03T00:02:00.000Z');
    await service.reconcileProvisioning();

    expect(deleteServer).toHaveBeenCalledWith(123461);
    expect(deleteServer).not.toHaveBeenCalledWith(50);
    expect(await db.executor.selectFrom('provider_deletion_queue').select('provider_server_id')
      .where('provider_server_id', '=', 50).execute()).toEqual([]);
    expect(await getUserMachine(db, recovery.machineId)).toMatchObject({
      status: 'recovering',
      hetznerServerId: null,
      recoveryOldServerId: 50,
      recoveryEncryptedPayload: expect.any(String),
    });

    currentNow = new Date('2026-07-04T00:00:00.000Z');
    await service.reconcileProvisioning();
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000010')).resolves.toMatchObject({
      status: 'running', hetznerServerId: 50,
      recoveryOldServerId: null, recoveryEncryptedPayload: null,
    });
    await expect(getUserMachine(db, recovery.machineId)).resolves.toBeUndefined();
  });

  it('does not apply a cascaded historical provisioning job to clean recovery registration', async () => {
    await db.executor.insertInto('provisioning_jobs').values({
      job_id: '50000000-0000-4000-8000-000000000001',
      machine_id: '30000000-0000-4000-8000-000000000010',
      status: 'completed', attempts: 1,
      available_at: '2026-07-01T00:00:00.000Z', claimed_at: '2026-07-01T00:00:01.000Z',
      lease_expires_at: null, encrypted_payload: 'legacy-completed-payload', last_error_code: null,
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:01:00.000Z',
      completed_at: '2026-07-01T00:01:00.000Z', target_bundle_version: 'v1',
      target_bundle_sha256: '1'.repeat(64), image_source: 'snapshot',
      snapshot_id: '10000000-0000-4000-8000-000000000010', snapshot_lease_id: null,
      activation_step: 'registered', provider_create_action_id: null, fallback_reason: null,
    }).execute();
    const config = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'false',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config, hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000016',
      tokenFactory: () => ({
        token: 'clean-recovery-registration-token',
        hash: hashRegistrationToken('clean-recovery-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    const recovery = await service.recover({ clerkUserId: 'user_recover', runtimeSlot: 'primary' });
    await expect(service.register('clean-recovery-registration-token', {
      machineId: recovery.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'v2',
      bundleSha256: '2'.repeat(64),
      healthy: true,
    })).resolves.toMatchObject({ registered: true, status: 'running' });
    expect(await getUserMachine(db, recovery.machineId)).toMatchObject({
      sourceSnapshotId: null,
      sourceBaseGeneration: null,
      targetBundleVersion: 'v2',
      targetBundleSha256: '2'.repeat(64),
    });
  });
});
