import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveUserMachineByClerkId,
  getUserMachine,
  insertUserMachine,
  parseNullableProviderActionId,
  promoteHostBundleChannel,
  updateUserMachine,
  upsertHostBundleRelease,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { insertProvisioningJob, sealProvisioningPayload, getProvisioningJob } from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import {
  chooseProvisioningImage,
  chooseRecoveryImage,
  fallbackProvisioningImage,
} from '../../packages/platform/src/golden-snapshot-activation.js';
import {
  advanceGoldenSnapshot,
  claimGoldenSnapshotBuild,
  createGoldenSnapshotCreateIntent,
  enqueueGoldenSnapshotBuild,
  markGoldenSnapshotReady,
  recordGoldenSnapshotProviderImage,
  retryGoldenSnapshotBuild,
  revokeGoldenSnapshot,
  updateGoldenSnapshotRolloutControl,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import type { GoldenSnapshotRuntimeConfig } from '../../packages/platform/src/golden-snapshot-schema.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { normalizePreviewTestProviderImageId } from '../../packages/platform/src/golden-snapshot-preview-test.js';

const compatibility = {
  provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central', baseImage: 'ubuntu-24.04',
  baseGeneration: 'ubuntu-24.04-v1', bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
};
const config: GoldenSnapshotRuntimeConfig = {
  enabled: true, buildsEnabled: false, rolloutPercent: 100, compatibility,
  maxBuildAttempts: 5, maxConcurrentBuilds: 2, buildLeaseMs: 300_000, provisioningLeaseMs: 600_000,
  retentionLimit: 20, freshnessMaxAgeMs: 7 * 24 * 60 * 60 * 1000, reconciliationBatchSize: 25,
  testModeTtlMs: 24 * 60 * 60 * 1000, auditRetentionMs: 90 * 24 * 60 * 60 * 1000,
};

describe('golden snapshot provisioning activation', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    for (const [version, day, sha] of [['v1', '01', '1'], ['v2', '02', '2']] as const) {
      await upsertHostBundleRelease(db, {
        version, gitCommit: sha.repeat(7), buildTime: `2026-07-${day}T00:00:00.000Z`,
        bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, checksumKey: null,
        sha256: sha.repeat(64), size: 100, createdAt: `2026-07-${day}T00:00:00.000Z`,
      });
    }
    await insertUserMachine(db, {
      machineId: '30000000-0000-4000-8000-000000000001', clerkUserId: 'user_1', handle: 'alice',
      runtimeSlot: 'primary', developerTools: [], status: 'provisioning', imageVersion: 'v2',
      provisionedAt: '2026-07-03T00:00:00.000Z',
    });
    await insertProvisioningJob(db, {
      jobId: '50000000-0000-4000-8000-000000000001',
      machineId: '30000000-0000-4000-8000-000000000001',
      encryptedPayload: sealProvisioningPayload({ registrationToken: 'registration-token', postgresPassword: 'postgres-password' }, 'platform-secret'),
      availableAt: '2026-07-03T00:00:00.000Z', createdAt: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('provisioning_jobs').set({ status: 'running' })
      .where('job_id', '=', '50000000-0000-4000-8000-000000000001').execute();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  it('normalizes Postgres BIGINT provider image ids before exact preview comparison', () => {
    expect(normalizePreviewTestProviderImageId('422202690')).toBe(422202690);
  });

  async function readySnapshot(version: 'v1' | 'v2', imageId: number, testMode = false) {
    const suffix = version === 'v1' ? '1' : '2';
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: version, compatibility,
      snapshotId: `10000000-0000-4000-8000-00000000000${suffix}`,
      buildId: `20000000-0000-4000-8000-00000000000${suffix}`,
      testMode,
      now: `2026-07-0${suffix}T01:00:00.000Z`,
    });
    const claimed = await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:00:00.500Z', '2026-07-03T00:10:00.000Z', 5,
    );
    const fence = claimed!.leaseExpiresAt!;
    await advanceGoldenSnapshot(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, fence, 'candidate', 'building', '2026-07-03T00:00:01.000Z');
    await advanceGoldenSnapshot(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, fence, 'building', 'sanitizing', '2026-07-03T00:00:02.000Z');
    await advanceGoldenSnapshot(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, fence, 'sanitizing', 'validating', '2026-07-03T00:00:03.000Z');
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId, expectedLeaseExpiresAt: fence,
      providerImageId: imageId, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:00:04.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'validation_boot', status: 'running', lease_expires_at: '2026-07-03T00:10:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await markGoldenSnapshotReady(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, {
      validationSummary: {
        exactBundle: true, healthy: true, freshActivation: true, uniqueMachineId: true,
        uniqueSshHostKey: true, forbiddenStateAbsent: true,
      }, expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z', now: '2026-07-03T00:00:05.000Z',
    });
    return enqueued.snapshot.snapshotId;
  }

  it('pins an exact test snapshot bundle when stable points to an older release', async () => {
    await promoteHostBundleChannel(db, 'stable', 'v1', '2026-07-03T00:00:00.000Z');
    const snapshotId = await readySnapshot('v2', 302, true);
    const createServer = vi.fn().mockResolvedValue({
      id: 903,
      status: 'running',
      serverType: 'cpx22',
      publicIPv4: '203.0.113.93',
      publicIPv6: '2001:db8::93/64',
    });
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret',
        CUSTOMER_VPS_IMAGE_VERSION: 'stable',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/stable/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        S3_ENDPOINT: 'https://r2.example',
        HETZNER_SERVER_TYPE: 'cpx22',
        GOLDEN_SNAPSHOTS_ENABLED: 'false',
        GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '0',
      }),
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000009',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000009',
      tokenFactory: () => ({
        token: 'preview-registration-token',
        hash: hashRegistrationToken('preview-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:01:00.000Z'),
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_preview_test',
      handle: 'pr-1273',
      runtimeSlot: 'pr-1273',
      testSnapshotId: snapshotId,
    })).resolves.toMatchObject({
      machineId: '30000000-0000-4000-8000-000000000009',
      status: 'provisioning',
    });

    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      image: 302,
      labels: expect.objectContaining({
        image_source: 'snapshot',
        snapshot_id: snapshotId,
      }),
    }));
    const createInput = createServer.mock.calls[0]?.[0];
    expect(createInput?.userData).toContain(
      'MATRIX_HOST_BUNDLE_URL=https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
    );
    expect(createInput?.userData).toContain('MATRIX_IMAGE_VERSION=v2');
    expect(createInput?.userData).toContain('MATRIX_UPDATE_CHANNEL=stable');
    await expect(db.executor.selectFrom('golden_snapshot_rollout_controls')
      .selectAll().execute()).resolves.toEqual([]);
    await expect(getProvisioningJob(db, '50000000-0000-4000-8000-000000000009'))
      .resolves.toMatchObject({
        imageSource: 'snapshot',
        snapshotId,
        targetBundleVersion: 'v2',
        targetBundleSha256: '2'.repeat(64),
      });
    await expect(db.executor.selectFrom('golden_snapshot_create_intents')
      .select(['snapshot_id', 'machine_id', 'rollout_generation', 'state'])
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000009')
      .executeTakeFirstOrThrow()).resolves.toEqual({
      snapshot_id: snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000009',
      rollout_generation: 0,
      state: 'accepted',
    });

    await expect(service.register('preview-registration-token', {
      machineId: '30000000-0000-4000-8000-000000000009',
      hetznerServerId: 903,
      publicIPv4: '203.0.113.93',
      publicIPv6: '2001:db8::93',
      imageVersion: 'v2',
      bundleSha256: '2'.repeat(64),
      healthy: true,
    })).resolves.toEqual({ registered: true, status: 'running' });
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000009'))
      .resolves.toMatchObject({
        status: 'running',
        sourceSnapshotId: snapshotId,
        sourceBaseGeneration: compatibility.baseGeneration,
      });
  });

  it('logs a bounded server-only reason when a leased preview snapshot becomes stale before dispatch', async () => {
    await promoteHostBundleChannel(db, 'stable', 'v1', '2026-07-03T00:00:00.000Z');
    const snapshotId = await readySnapshot('v2', 302, true);
    const createServer = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let nowCalls = 0;
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret',
        CUSTOMER_VPS_IMAGE_VERSION: 'stable',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/stable/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        S3_ENDPOINT: 'https://r2.example',
        HETZNER_SERVER_TYPE: 'cpx22',
        GOLDEN_SNAPSHOTS_ENABLED: 'false',
        GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '0',
        GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS: '60000',
      }),
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000019',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000019',
      tokenFactory: () => ({
        token: 'preview-registration-token',
        hash: hashRegistrationToken('preview-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date(nowCalls++ === 0
        ? '2026-07-03T00:01:00.000Z'
        : '2026-07-03T00:02:00.000Z'),
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_preview_diagnostic',
      handle: 'pr-12751',
      runtimeSlot: 'pr-12751',
      testSnapshotId: snapshotId,
    })).rejects.toMatchObject({
      code: 'snapshot_clone_rejected',
      publicMessage: 'Provisioning image unavailable',
    });

    expect(createServer).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      'internalReason=persisted_snapshot_stale',
    ));
  });

  it.each([
    ['nonstandard path', 'https://bundles.example/custom/latest.tar.gz'],
    ['query-only version segment', 'https://bundles.example/custom/latest.tar.gz?source=/system-bundles/stable/'],
    ['fragment-only version segment', 'https://bundles.example/custom/latest.tar.gz#/system-bundles/stable/'],
  ])('rejects an exact test snapshot for a custom bundle URL with a %s', async (_case, hostBundleUrl) => {
    await promoteHostBundleChannel(db, 'stable', 'v1', '2026-07-03T00:00:00.000Z');
    const snapshotId = await readySnapshot('v2', 302, true);
    const createServer = vi.fn();
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret',
        CUSTOMER_VPS_IMAGE_VERSION: 'stable',
        MATRIX_HOST_BUNDLE_URL: hostBundleUrl,
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        S3_ENDPOINT: 'https://r2.example',
        HETZNER_SERVER_TYPE: 'cpx22',
      }),
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date('2026-07-03T00:01:00.000Z'),
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_preview_custom_bundle',
      handle: 'pr-12741',
      runtimeSlot: 'pr-12741',
      testSnapshotId: snapshotId,
    })).rejects.toMatchObject({ code: 'snapshot_clone_rejected' });
    expect(createServer).not.toHaveBeenCalled();
  });

  it('rejects a non-test snapshot on the operator preview override before provider creation', async () => {
    const snapshotId = await readySnapshot('v2', 302);
    const createServer = vi.fn();
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret',
        CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        S3_ENDPOINT: 'https://r2.example',
        HETZNER_SERVER_TYPE: 'cpx22',
      }),
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000010',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000010',
      now: () => new Date('2026-07-03T00:01:00.000Z'),
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_preview_test',
      handle: 'pr-1274',
      runtimeSlot: 'pr-1274',
      testSnapshotId: snapshotId,
    })).rejects.toMatchObject({ code: 'snapshot_clone_rejected' });
    expect(createServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000010'))
      .resolves.toBeUndefined();
  });

  it('fails an exact preview test closed when the provider rejects the snapshot clone', async () => {
    const snapshotId = await readySnapshot('v2', 302, true);
    const createServer = vi.fn().mockRejectedValue(
      new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable'),
    );
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret',
        CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        S3_ENDPOINT: 'https://r2.example',
        HETZNER_SERVER_TYPE: 'cpx22',
        GOLDEN_SNAPSHOTS_ENABLED: 'false',
        GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '0',
      }),
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000011',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000011',
      now: () => new Date('2026-07-03T00:01:00.000Z'),
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_preview_test',
      handle: 'pr-1275',
      runtimeSlot: 'pr-1275',
      testSnapshotId: snapshotId,
    })).rejects.toMatchObject({ code: 'snapshot_clone_rejected' });
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ image: 302 }));
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000011'))
      .resolves.toMatchObject({ status: 'failed', failureCode: 'snapshot_clone_rejected' });
    await expect(db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000011')
      .executeTakeFirstOrThrow()).resolves.toMatchObject({
      released_at: '2026-07-03T00:01:00.000Z',
    });
  });

  it('never creates a second exact-test server after a persisted provider action is rejected', async () => {
    const snapshotId = await readySnapshot('v2', 302, true);
    let currentNow = new Date('2026-07-03T00:01:00.000Z');
    const firstServer = {
      id: 904, status: 'initializing' as const, publicIPv4: '203.0.113.94', createActionId: 1804,
      labels: {
        machine_id: '30000000-0000-4000-8000-000000000014',
        snapshot_id: snapshotId,
      },
    };
    const createServer = vi.fn()
      .mockResolvedValueOnce(firstServer)
      .mockResolvedValueOnce({
        ...firstServer, id: 905, publicIPv4: '203.0.113.95', createActionId: 1805,
      });
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const getServer = vi.fn().mockResolvedValue(firstServer);
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret',
        CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        S3_ENDPOINT: 'https://r2.example',
        HETZNER_SERVER_TYPE: 'cpx22',
        GOLDEN_SNAPSHOTS_ENABLED: 'false',
        GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '0',
      }),
      hetzner: createMockHetznerClient({
        createServer,
        deleteServer,
        getServer,
        getAction: vi.fn().mockResolvedValue({
          id: 1804, status: 'error', command: 'create_server',
        }),
        listServersByLabel: vi.fn().mockResolvedValue([]),
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000014',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000014',
      now: () => currentNow,
    });

    await expect(service.provisionPreview({
      clerkUserId: 'user_preview_action_retry',
      handle: 'pr-1273',
      runtimeSlot: 'pr-1273',
      testSnapshotId: snapshotId,
    })).rejects.toMatchObject({ code: 'snapshot_clone_rejected' });
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(deleteServer).toHaveBeenCalledWith(904);
    await expect(db.executor.selectFrom('provider_deletion_queue')
      .select(['provider_server_id', 'reason', 'completed_at'])
      .where('provider_server_id', '=', 904)
      .executeTakeFirstOrThrow()).resolves.toEqual({
      provider_server_id: 904,
      reason: 'rejected_snapshot_clone',
      completed_at: null,
    });

    currentNow = new Date('2026-07-03T00:07:00.000Z');
    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ checked: 0 });
    expect(createServer).toHaveBeenCalledTimes(1);
    await expect(getProvisioningJob(db, '50000000-0000-4000-8000-000000000014'))
      .resolves.toMatchObject({
        status: 'failed',
        providerCreateActionId: 1804,
      });
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000014'))
      .resolves.toMatchObject({ status: 'failed', failureCode: 'snapshot_clone_rejected' });
  });

  it('atomically selects an exact snapshot, leases it, and persists durable activation provenance', async () => {
    const snapshotId = await readySnapshot('v2', 302);
    const selected = await chooseProvisioningImage(db, config, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });
    expect(selected).toMatchObject({ imageSource: 'snapshot', providerImageId: 302, snapshotId, exact: true });
    expect(await getProvisioningJob(db, '50000000-0000-4000-8000-000000000001')).toMatchObject({
      imageSource: 'snapshot', snapshotId, snapshotLeaseId: '40000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', targetBundleSha256: '2'.repeat(64), activationStep: 'creating',
    });
  });

  it('links the provisioning job to its singleton create intent', async () => {
    const snapshotId = await readySnapshot('v2', 302);
    const leaseId = '40000000-0000-4000-8000-000000000001';
    const intentId = '60000000-0000-4000-8000-000000000001';
    const selected = await chooseProvisioningImage(db, config, {
      jobId: '50000000-0000-4000-8000-000000000001',
      machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision', leaseId,
      now: '2026-07-03T00:01:00.000Z',
    });
    expect(selected).toMatchObject({ imageSource: 'snapshot', snapshotId, snapshotLeaseId: leaseId });

    await expect(createGoldenSnapshotCreateIntent(db, {
      intentId, snapshotId, leaseId, machineId: '30000000-0000-4000-8000-000000000001',
      purpose: 'provision', rolloutGeneration: 1, now: '2026-07-03T00:02:00.000Z',
    })).resolves.toMatchObject({ intentId });
    await expect(createGoldenSnapshotCreateIntent(db, {
      intentId: '60000000-0000-4000-8000-000000000002',
      snapshotId, leaseId, machineId: '30000000-0000-4000-8000-000000000001',
      purpose: 'provision', rolloutGeneration: 1, now: '2026-07-03T00:03:00.000Z',
    })).resolves.toMatchObject({ intentId });
    await expect(getProvisioningJob(db, '50000000-0000-4000-8000-000000000001'))
      .resolves.toMatchObject({ snapshotCreateIntentId: intentId });
  });

  it('falls back to a clean image when no exact snapshot exists', async () => {
    await readySnapshot('v1', 301);
    const selected = await chooseProvisioningImage(db, config, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });
    expect(selected).toEqual({
      imageSource: 'clean_image', targetBundleVersion: 'v2', targetBundleSha256: '2'.repeat(64),
    });
  });

  it('never selects a snapshot outside the configured freshness window', async () => {
    const snapshotId = await readySnapshot('v2', 302);
    await db.executor.updateTable('golden_snapshots').set({
      ready_at: '2026-06-01T00:00:00.000Z',
    }).where('snapshot_id', '=', snapshotId).execute();

    const selected = await chooseProvisioningImage(db, config, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });

    expect(selected).toEqual({
      imageSource: 'clean_image', targetBundleVersion: 'v2', targetBundleSha256: '2'.repeat(64),
    });
  });

  it('falls back clean when a persisted snapshot decision expires before provisioning resumes', async () => {
    await readySnapshot('v2', 302);
    await chooseProvisioningImage(db, config, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });
    await db.executor.updateTable('provisioning_jobs').set({
      status: 'queued', lease_expires_at: null, available_at: '2026-07-20T00:00:00.000Z',
      provider_create_action_id: 1700,
    }).where('job_id', '=', '50000000-0000-4000-8000-000000000001').execute();
    const createServer = vi.fn().mockResolvedValue({
      id: 1201, status: 'running', publicIPv4: '203.0.113.201', createActionId: 1701,
    });
    const getAction = vi.fn().mockImplementation(async (actionId: number) => ({
      id: actionId,
      status: actionId === 1700 ? 'error' as const : 'success' as const,
      command: 'create_server',
    }));
    const staleServer = {
      id: 1200, status: 'running' as const, publicIPv4: '203.0.113.200',
      labels: {
        machine_id: '30000000-0000-4000-8000-000000000001',
        snapshot_id: '10000000-0000-4000-8000-000000000002',
      },
    };
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS: String(7 * 24 * 60 * 60 * 1000),
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig, hetzner: createMockHetznerClient({
        createServer, deleteServer, getAction,
        listServersByLabel: vi.fn().mockResolvedValue([staleServer]),
        getServer: vi.fn().mockResolvedValue(null),
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    });

    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(deleteServer).toHaveBeenCalledWith(1200);
    expect(createServer).toHaveBeenCalledWith(expect.not.objectContaining({ image: 302 }));
    expect(getAction).toHaveBeenCalledWith(1701);
    expect(getAction).not.toHaveBeenCalledWith(1700);
    await expect(getProvisioningJob(db, '50000000-0000-4000-8000-000000000001')).resolves.toMatchObject({
      imageSource: 'clean_image', fallbackReason: 'snapshot_stale', snapshotId: null, snapshotLeaseId: null,
    });
  });

  it('falls back to clean image when disabled, incompatible, absent, or clone preparation fails', async () => {
    const clean = await chooseProvisioningImage(db, { ...config, enabled: false }, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });
    expect(clean).toEqual({ imageSource: 'clean_image', targetBundleVersion: 'v2', targetBundleSha256: '2'.repeat(64) });

    await readySnapshot('v2', 302);
    const snapshot = await db.executor.selectFrom('golden_snapshots').select('compatibility_key')
      .where('provider_image_id', '=', 302).executeTakeFirstOrThrow();
    await updateGoldenSnapshotRolloutControl(db, {
      compatibilityKey: snapshot.compatibility_key,
      enabled: true,
      percentage: 100,
      now: '2026-07-03T00:01:30.000Z',
    });
    const selected = await chooseProvisioningImage(db, config, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:02:00.000Z',
    });
    expect(selected.imageSource).toBe('snapshot');
    await db.executor.updateTable('provisioning_jobs').set({ provider_create_action_id: 888 })
      .where('job_id', '=', '50000000-0000-4000-8000-000000000001').execute();
    await fallbackProvisioningImage(db, {
      jobId: '50000000-0000-4000-8000-000000000001', reason: 'clone_rejected', now: '2026-07-03T00:03:00.000Z',
    });
    expect(await getProvisioningJob(db, '50000000-0000-4000-8000-000000000001')).toMatchObject({
      imageSource: 'clean_image', snapshotId: null, snapshotLeaseId: null,
      providerCreateActionId: null, activationStep: 'fallback_pending', fallbackReason: 'clone_rejected',
    });
  });

  it('persists a clean decision when rollout is excluded and release metadata is missing', async () => {
    await db.executor.deleteFrom('host_bundle_releases').where('version', '=', 'v2').execute();
    const clean = await chooseProvisioningImage(db, { ...config, rolloutPercent: 0 }, {
      jobId: '50000000-0000-4000-8000-000000000001',
      machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });
    expect(clean).toEqual({
      imageSource: 'clean_image', targetBundleVersion: 'v2', targetBundleSha256: '0'.repeat(64),
    });
    expect(await getProvisioningJob(db, '50000000-0000-4000-8000-000000000001')).toMatchObject({
      imageSource: 'clean_image', activationStep: 'creating', targetBundleVersion: 'v2',
    });
  });

  it('does not create a provider server when snapshot mode cannot prove the target digest', async () => {
    await db.executor.deleteFrom('host_bundle_releases').where('version', '=', 'v2').execute();
    await db.executor.updateTable('provisioning_jobs').set({ status: 'queued' })
      .where('job_id', '=', '50000000-0000-4000-8000-000000000001').execute();
    const createServer = vi.fn();
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
        GOLDEN_SNAPSHOTS_ENABLED: 'true',
      }),
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date('2026-07-03T00:10:00.000Z'),
    });

    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ completed: 0, failed: 1 });
    expect(createServer).not.toHaveBeenCalled();
    await expect(getUserMachine(db, '30000000-0000-4000-8000-000000000001'))
      .resolves.toMatchObject({ status: 'failed', failureCode: 'provider_unavailable' });
  });

  it('restores the predecessor when a snapshot rejection is followed by clean recovery failure', async () => {
    await db.executor.deleteFrom('provisioning_jobs')
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000001').execute();
    await db.executor.deleteFrom('user_machines')
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000001').execute();
    await insertUserMachine(db, {
      machineId: '30000000-0000-4000-8000-000000000030', clerkUserId: 'user_30', handle: 'restore-me',
      runtimeSlot: 'primary', developerTools: [], status: 'running', imageVersion: 'v2',
      hetznerServerId: 930, publicIPv4: '203.0.113.130', provisionedAt: '2026-07-03T00:00:00.000Z',
    });
    await readySnapshot('v2', 302);
    const createServer = vi.fn()
      .mockRejectedValueOnce(new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable'))
      .mockRejectedValueOnce(new CustomerVpsError(409, 'quota_exceeded', 'Provisioning capacity unavailable'));
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
        GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
        GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      }),
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000031',
      now: () => new Date('2026-07-03T00:10:00.000Z'),
    });

    await expect(service.recover({ clerkUserId: 'user_30' }))
      .rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(createServer).toHaveBeenCalledTimes(2);
    await expect(getActiveUserMachineByClerkId(db, 'user_30')).resolves.toMatchObject({
      machineId: '30000000-0000-4000-8000-000000000030',
      status: 'running', hetznerServerId: 930, publicIPv4: '203.0.113.130',
    });
    expect((await db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000031').executeTakeFirstOrThrow()).released_at)
      .toBe('2026-07-03T00:10:00.000Z');
  });

  it('serializes clean recovery fallback against concurrent expired restoration', async () => {
    await db.executor.deleteFrom('provisioning_jobs').execute();
    await db.executor.deleteFrom('user_machines').execute();
    await insertUserMachine(db, {
      machineId: '30000000-0000-4000-8000-000000000040', clerkUserId: 'user_40', handle: 'race-safe',
      runtimeSlot: 'primary', developerTools: [], status: 'running', imageVersion: 'v2',
      hetznerServerId: 940, publicIPv4: '203.0.113.140', provisionedAt: '2026-07-03T00:00:00.000Z',
    });
    await readySnapshot('v2', 302);

    let clock = new Date('2026-07-03T00:00:00.000Z');
    let resolveFallbackCreate!: (server: {
      id: number; status: 'running'; publicIPv4: string;
    }) => void;
    const fallbackCreate = new Promise<{
      id: number; status: 'running'; publicIPv4: string;
    }>((resolve) => {
      resolveFallbackCreate = resolve;
    });
    const createServer = vi.fn()
      .mockResolvedValueOnce({
        id: 941, status: 'initializing', publicIPv4: '203.0.113.141', createActionId: 1741,
      })
      .mockImplementationOnce(() => fallbackCreate);
    const getAction = vi.fn().mockResolvedValue({
      id: 1741, status: 'running', command: 'create_server',
    });
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
        GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
        GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      }),
      hetzner: createMockHetznerClient({
        createServer,
        getAction,
        getServer: vi.fn().mockResolvedValue(null),
        listServersByLabel: vi.fn().mockResolvedValue([]),
      }),
      systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) }),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000041',
      now: () => clock,
    });

    await service.recover({ clerkUserId: 'user_40' });
    clock = new Date('2026-07-03T00:14:00.000Z');
    getAction.mockResolvedValue({ id: 1741, status: 'error', command: 'create_server' });

    const firstReconcile = service.reconcileProvisioning();
    await vi.waitFor(() => expect(createServer).toHaveBeenCalledTimes(2));
    clock = new Date('2026-07-03T00:16:00.000Z');
    const secondReconcile = service.reconcileProvisioning();
    resolveFallbackCreate({ id: 942, status: 'running', publicIPv4: '203.0.113.142' });
    await Promise.all([firstReconcile, secondReconcile]);

    await expect(getActiveUserMachineByClerkId(db, 'user_40')).resolves.toMatchObject({
      machineId: '30000000-0000-4000-8000-000000000041',
      status: 'recovering',
      hetznerServerId: 942,
      sourceSnapshotId: null,
    });
    expect(createServer).toHaveBeenCalledTimes(2);
  });

  it('keeps Postgres rollout authority after process-local defaults change', async () => {
    await readySnapshot('v2', 329);
    const input = {
      jobId: '50000000-0000-4000-8000-000000000001',
      machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision' as const,
      leaseId: '40000000-0000-4000-8000-000000000029', now: '2026-07-03T00:01:00.000Z',
    };
    await expect(chooseProvisioningImage(db, { ...config, enabled: false, rolloutPercent: 0 }, input))
      .resolves.toMatchObject({ imageSource: 'clean_image' });
    await expect(chooseProvisioningImage(db, config, { ...input, now: '2026-07-03T00:02:00.000Z' }))
      .resolves.toMatchObject({ imageSource: 'clean_image' });

    const snapshot = await db.executor.selectFrom('golden_snapshots').select('compatibility_key')
      .where('provider_image_id', '=', 329).executeTakeFirstOrThrow();
    await updateGoldenSnapshotRolloutControl(db, {
      compatibilityKey: snapshot.compatibility_key,
      enabled: true,
      percentage: 100,
      now: '2026-07-03T00:03:00.000Z',
    });
    await expect(chooseProvisioningImage(db, config, { ...input, now: '2026-07-03T00:04:00.000Z' }))
      .resolves.toMatchObject({ imageSource: 'snapshot', rolloutGeneration: 2 });
  });

  it('rejects metadata-free provisioning and recovery registration when exact provenance is unavailable', async () => {
    const machineId = '30000000-0000-4000-8000-000000000001';
    await db.executor.deleteFrom('host_bundle_releases').where('version', '=', 'v2').execute();
    await chooseProvisioningImage(db, { ...config, rolloutPercent: 0 }, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId,
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });
    await db.transaction(async (trx) => {
      await trx.executor.updateTable('user_machines').set({
        hetzner_server_id: 902,
        registration_token_hash: hashRegistrationToken('metadata-free-token'),
        registration_token_expires_at: '2026-07-03T01:00:00.000Z',
      }).where('machine_id', '=', machineId).execute();
      await trx.executor.updateTable('provisioning_jobs').set({ activation_step: 'created' })
        .where('machine_id', '=', machineId).execute();
    });
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
        GOLDEN_SNAPSHOTS_ENABLED: 'true',
      }),
      hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date('2026-07-03T00:10:00.000Z'),
    });

    await expect(service.register('metadata-free-token', {
      machineId, hetznerServerId: 902, publicIPv4: '203.0.113.92', imageVersion: 'v2',
      bundleSha256: '0'.repeat(64), healthy: true,
    })).rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'provisioning' });

    await updateUserMachine(db, machineId, {
      status: 'recovering', targetBundleVersion: 'v2', targetBundleSha256: '0'.repeat(64),
    });
    await expect(service.register('metadata-free-token', {
      machineId, hetznerServerId: 902, publicIPv4: '203.0.113.92', imageVersion: 'v2',
      bundleSha256: '0'.repeat(64), healthy: true,
    })).rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'recovering' });
  });

  it('rejects a clean-image registration until exact target provenance and health match', async () => {
    const machineId = '30000000-0000-4000-8000-000000000001';
    await db.transaction(async (trx) => {
      await trx.executor.updateTable('user_machines').set({
        hetzner_server_id: 901,
        registration_token_hash: hashRegistrationToken('clean-registration-token'),
        registration_token_expires_at: '2026-07-03T01:00:00.000Z',
      }).where('machine_id', '=', machineId).execute();
      await trx.executor.updateTable('provisioning_jobs').set({
        image_source: 'clean_image', target_bundle_version: 'v2',
        target_bundle_sha256: '2'.repeat(64), activation_step: 'created',
      }).where('machine_id', '=', machineId).execute();
    });
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig, hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date('2026-07-03T00:10:00.000Z'),
    });
    const register = (imageVersion: string, bundleSha256: string, healthy: boolean) =>
      service.register('clean-registration-token', {
        machineId, hetznerServerId: 901, publicIPv4: '203.0.113.91',
        imageVersion, bundleSha256, healthy,
      });

    await expect(register('v1', '2'.repeat(64), true))
      .rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(register('v2', '1'.repeat(64), true))
      .rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(register('v2', '2'.repeat(64), false))
      .rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'provisioning' });
    await expect(register('v2', '2'.repeat(64), true))
      .resolves.toMatchObject({ registered: true, status: 'running' });
  });

  it('resets the bounded attempt budget for an explicit operator retry', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000008',
      buildId: '20000000-0000-4000-8000-000000000008', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'failed', failure_code: 'retry_exhausted' })
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'failed', phase: 'failed', attempts: config.maxBuildAttempts,
      provider_builder_id: 801, provider_builder_action_id: 800, provider_snapshot_action_id: 802,
      provider_validation_id: 803, provider_validation_action_id: 804,
      callback_phase: 'validated', callback_token_hash: 'a'.repeat(64),
      callback_expires_at: null, pending_operation: null,
    }).where('build_id', '=', enqueued.build.buildId).execute();

    expect(await retryGoldenSnapshotBuild(db, enqueued.build.buildId, '2026-07-03T00:10:00.000Z')).toBe(false);
    const cleanup = await db.executor.selectFrom('golden_snapshot_cleanup')
      .select(['cleanup_id', 'resource_type', 'provider_resource_id', 'reason'])
      .orderBy('provider_resource_id').execute();
    expect(cleanup.map(({ cleanup_id: _cleanupId, ...row }) => row)).toEqual([
      { resource_type: 'builder_server', provider_resource_id: 801, reason: 'operator_retry' },
      { resource_type: 'validation_server', provider_resource_id: 803, reason: 'operator_retry' },
    ]);
    await db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'completed', completed_at: '2026-07-03T00:10:30.000Z', attempts: 1,
    }).where('cleanup_id', 'in', cleanup.map((row) => row.cleanup_id)).execute();
    expect(await retryGoldenSnapshotBuild(db, enqueued.build.buildId, '2026-07-03T00:11:00.000Z')).toBe(true);
    expect(await db.executor.selectFrom('golden_snapshot_builds').select([
      'status', 'phase', 'attempts', 'provider_builder_id', 'provider_snapshot_action_id',
      'provider_builder_action_id',
      'provider_validation_id', 'provider_validation_action_id', 'callback_phase',
      'callback_token_hash', 'callback_expires_at', 'pending_operation',
    ])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirst()).toEqual({
      status: 'queued', phase: 'requested', attempts: 0,
      provider_builder_id: null, provider_builder_action_id: null, provider_snapshot_action_id: null,
      provider_validation_id: null, provider_validation_action_id: null,
      callback_phase: null, callback_token_hash: null, callback_expires_at: null,
      pending_operation: null,
    });
    expect(await db.executor.selectFrom('golden_snapshot_cleanup')
      .select('completed_at').where('build_id', '=', enqueued.build.buildId).execute())
      .toEqual([{ completed_at: '2026-07-03T00:10:30.000Z' }, { completed_at: '2026-07-03T00:10:30.000Z' }]);
  });

  it('blocks operator retry until an ambiguous create has been reconciled', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000028',
      buildId: '20000000-0000-4000-8000-000000000028', now: '2026-07-03T00:00:00.000Z',
    });
    const deadline = '2026-07-03T00:30:00.000Z';
    await db.executor.updateTable('golden_snapshots').set({
      state: 'failed', failure_code: 'provider_create_ambiguous',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'failed', phase: 'failed', attempts: config.maxBuildAttempts,
      pending_operation: `builder:${enqueued.build.buildId}`, callback_expires_at: deadline,
    }).where('build_id', '=', enqueued.build.buildId).execute();

    await expect(retryGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:10:00.000Z',
    )).resolves.toBe(false);
    await expect(db.executor.selectFrom('golden_snapshot_builds')
      .select(['status', 'pending_operation', 'callback_expires_at'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow()).resolves.toEqual({
      status: 'failed',
      pending_operation: `builder:${enqueued.build.buildId}`,
      callback_expires_at: deadline,
    });
  });

  it('coerces persisted recovery action BIGINT values to safe numbers', async () => {
    expect(parseNullableProviderActionId('9004')).toBe(9004);
    expect(parseNullableProviderActionId(null)).toBeNull();
    expect(() => parseNullableProviderActionId('9007199254740992')).toThrow();

    await db.executor.updateTable('user_machines').set({
      recovery_create_action_id: 9004,
    }).where('machine_id', '=', '30000000-0000-4000-8000-000000000001').execute();

    const machine = await getUserMachine(db, '30000000-0000-4000-8000-000000000001');
    expect(machine?.recoveryCreateActionId).toBe(9004);
    expect(typeof machine?.recoveryCreateActionId).toBe('number');
  });

  it('locks a source generation and snapshot before its create intent during registration', async () => {
    const source = await readFile(
      new URL('../../packages/platform/src/customer-vps.ts', import.meta.url),
      'utf8',
    );
    const registerStart = source.indexOf('async register(token, input)');
    const transactionStart = source.indexOf('runInPlatformTransaction', registerStart);
    const transactionEnd = source.indexOf('return { registered: true', transactionStart);
    const registrationTransaction = source.slice(transactionStart, transactionEnd);
    const generationLock = registrationTransaction.indexOf('pg_advisory_xact_lock');
    const snapshotLock = registrationTransaction.indexOf("selectFrom('golden_snapshots')");
    const intentLock = registrationTransaction.indexOf("selectFrom('golden_snapshot_create_intents')");

    expect(generationLock).toBeGreaterThanOrEqual(0);
    expect(snapshotLock).toBeGreaterThan(generationLock);
    expect(intentLock).toBeGreaterThan(snapshotLock);
  });

  it('retries a quarantined image-less build only after exact cleanup completes', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000018',
      buildId: '20000000-0000-4000-8000-000000000018', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', failure_code: 'builder_activation_services_ready_failed',
      quarantined_at: '2026-07-03T00:05:00.000Z',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'failed', phase: 'failed', attempts: 1, provider_builder_id: 811,
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await db.executor.insertInto('golden_snapshot_cleanup').values({
      cleanup_id: '60000000-0000-4000-8000-000000000018',
      snapshot_id: enqueued.snapshot.snapshotId, build_id: enqueued.build.buildId,
      resource_type: 'builder_server', provider_resource_id: 811,
      provenance_key: `build:${enqueued.build.buildId}:builder_server`,
      reason: 'builder_activation_services_ready_failed', status: 'queued', attempts: 0,
      next_attempt_at: '2026-07-03T00:05:00.000Z', lease_expires_at: null,
      last_error_code: null, created_at: '2026-07-03T00:05:00.000Z',
      completed_at: null,
    }).execute();

    expect(await retryGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:09:00.000Z',
    )).toBe(false);
    await db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'completed', attempts: 1, completed_at: '2026-07-03T00:09:30.000Z',
    }).where('cleanup_id', '=', '60000000-0000-4000-8000-000000000018').execute();
    expect(await retryGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:10:00.000Z',
    )).toBe(true);
    expect(await db.executor.selectFrom('golden_snapshots').select('state')
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).executeTakeFirst()).toEqual({ state: 'candidate' });
    expect(await db.executor.selectFrom('golden_snapshot_cleanup').select('cleanup_id')
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId)
      .where('completed_at', 'is', null).execute()).toEqual([]);
  });

  it('enforces exact bundle provenance when a snapshot recovery registers', async () => {
    await readySnapshot('v2', 302);
    const machineId = '30000000-0000-4000-8000-000000000009';
    const decision = await chooseRecoveryImage(db, config, {
      machineId, targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'recover',
      leaseId: '40000000-0000-4000-8000-000000000009', now: '2026-07-03T00:01:00.000Z',
    });
    expect(decision.imageSource).toBe('snapshot');
    if (decision.imageSource !== 'snapshot') throw new Error('expected snapshot recovery decision');
    await insertUserMachine(db, {
      machineId, clerkUserId: 'user_9', handle: 'recovered', runtimeSlot: 'primary',
      developerTools: [], status: 'recovering', imageVersion: 'v2', hetznerServerId: 909,
      registrationTokenHash: hashRegistrationToken('recovery-token'),
      registrationTokenExpiresAt: '2026-07-03T01:00:00.000Z',
      provisionedAt: '2026-07-03T00:02:00.000Z',
    });
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig, hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore(), now: () => new Date('2026-07-03T00:03:00.000Z'),
    });

    await expect(service.register('recovery-token', {
      machineId, hetznerServerId: 909, publicIPv4: '203.0.113.19', imageVersion: 'v1',
      bundleSha256: '1'.repeat(64), healthy: true,
    })).rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    expect((await db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', machineId).executeTakeFirstOrThrow()).released_at).toBeNull();
    await revokeGoldenSnapshot(
      db, decision.snapshotId,
      'operator_revoked', '2026-07-03T00:02:30.000Z',
    );
    await expect(service.register('recovery-token', {
      machineId, hetznerServerId: 909, publicIPv4: '203.0.113.19', imageVersion: 'v2',
      bundleSha256: '2'.repeat(64), healthy: true,
    })).rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    expect((await db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', machineId).executeTakeFirstOrThrow()).released_at).toBeNull();
  });

  it('holds the leased exact image through create completion and releases it only after registration', async () => {
    vi.useFakeTimers();
    await readySnapshot('v2', 302);
    let currentNow = new Date('2026-07-03T00:10:00.000Z');
    let created = false;
    const server = { id: 123456, status: 'running' as const, publicIPv4: '203.0.113.10', createActionId: 777,
      labels: { machine_id: '30000000-0000-4000-8000-000000000002', snapshot_id: '10000000-0000-4000-8000-000000000002' } };
    const getAction = vi.fn()
      .mockResolvedValueOnce({ id: 777, status: 'running', command: 'create_server' })
      .mockResolvedValueOnce({ id: 777, status: 'success', command: 'create_server' });
    const hetzner = createMockHetznerClient({
      createServer: vi.fn(async () => { created = true; return server; }),
      listServersByLabel: vi.fn(async () => created ? [server] : []),
      getAction,
    });
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig, hetzner, systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000002',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000002',
      now: () => currentNow,
    });

    const provisioning = service.provision({ clerkUserId: 'user_2', handle: 'bob', runtimeSlot: 'primary' });
    await vi.advanceTimersByTimeAsync(1_000);
    await provisioning;

    expect(hetzner.createServer).toHaveBeenCalledWith(expect.objectContaining({ image: 302 }));
    expect(await getProvisioningJob(db, '50000000-0000-4000-8000-000000000002')).toMatchObject({
      status: 'completed', imageSource: 'snapshot', providerCreateActionId: 777,
      activationStep: 'created',
    });
    expect((await db.executor.selectFrom('golden_snapshot_leases').selectAll()
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000002').executeTakeFirstOrThrow()).released_at).toBeNull();

    currentNow = new Date('2026-07-03T00:20:01.000Z');
    await service.reconcileProvisioning();
    expect(await getProvisioningJob(db, '50000000-0000-4000-8000-000000000002')).toMatchObject({
      status: 'completed', imageSource: 'snapshot', activationStep: 'created',
    });
    const lease = await db.executor.selectFrom('golden_snapshot_leases').selectAll()
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000002').executeTakeFirstOrThrow();
    expect(lease.released_at).toBeNull();
    expect(getAction).toHaveBeenCalledTimes(2);
    await db.executor.updateTable('user_machines').set({
      registration_token_hash: hashRegistrationToken('registration-token'),
      registration_token_expires_at: '2026-07-03T00:30:00.000Z',
    }).where('machine_id', '=', '30000000-0000-4000-8000-000000000002').execute();
    await expect(service.register('registration-token', {
      machineId: '30000000-0000-4000-8000-000000000002', hetznerServerId: 123456,
      publicIPv4: '203.0.113.10', imageVersion: 'v2',
    })).rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(service.register('registration-token', {
      machineId: '30000000-0000-4000-8000-000000000002', hetznerServerId: 123456,
      publicIPv4: '203.0.113.10', imageVersion: 'v2', bundleSha256: '2'.repeat(64), healthy: true,
    })).resolves.toMatchObject({ registered: true, status: 'running' });
    expect((await db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', '30000000-0000-4000-8000-000000000002').executeTakeFirstOrThrow()).released_at)
      .toBe('2026-07-03T00:20:01.000Z');
    expect(await getUserMachine(db, '30000000-0000-4000-8000-000000000002')).toMatchObject({
      sourceSnapshotId: '10000000-0000-4000-8000-000000000002',
      sourceBaseGeneration: 'ubuntu-24.04-v1',
      targetBundleVersion: 'v2',
      targetBundleSha256: '2'.repeat(64),
    });
  });

  it('accepts registration idempotently when a concurrent request already activated the create intent', async () => {
    await readySnapshot('v2', 302);
    const machineId = '30000000-0000-4000-8000-000000000022';
    const jobId = '50000000-0000-4000-8000-000000000022';
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
        GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
        S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
      }),
      hetzner: createMockHetznerClient({
        createServer: vi.fn().mockResolvedValue({
          id: 1022, status: 'running', publicIPv4: '203.0.113.122',
          labels: { machine_id: machineId, snapshot_id: '10000000-0000-4000-8000-000000000002' },
        }),
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => machineId,
      provisioningJobIdFactory: () => jobId,
      tokenFactory: () => ({
        token: 'concurrent-registration-token', hash: hashRegistrationToken('concurrent-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:20:00.000Z'),
    });

    await service.provision({ clerkUserId: 'user_22', handle: 'concurrent', runtimeSlot: 'primary' });
    await db.executor.updateTable('golden_snapshot_create_intents').set({ state: 'activated' })
      .where('machine_id', '=', machineId).execute();

    await expect(service.register('concurrent-registration-token', {
      machineId, hetznerServerId: 1022, publicIPv4: '203.0.113.122', imageVersion: 'v2',
      bundleSha256: '2'.repeat(64), healthy: true,
    })).resolves.toMatchObject({ registered: true, status: 'running' });
  });

  it('preserves the requested location when a rejected snapshot clone falls back synchronously', async () => {
    await readySnapshot('v2', 302);
    const createServer = vi.fn()
      .mockRejectedValueOnce(new CustomerVpsError(500, 'snapshot_clone_rejected', 'Provisioning provider unavailable'))
      .mockResolvedValueOnce({ id: 123459, status: 'running', publicIPv4: '203.0.113.13' });
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22', HETZNER_LOCATION: 'nbg1',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig,
      hetzner: createMockHetznerClient({ createServer }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000003',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000003',
      now: () => new Date('2026-07-03T00:10:00.000Z'),
    });

    await service.provision({ clerkUserId: 'user_3', handle: 'carol', location: 'hil' });

    expect(createServer).toHaveBeenNthCalledWith(1, expect.objectContaining({ image: 302, location: 'hil' }));
    expect(createServer).toHaveBeenNthCalledWith(2, expect.objectContaining({ location: 'hil' }));
  });

  it('settles a running snapshot job when the clone registers before action reconciliation', async () => {
    await readySnapshot('v2', 302);
    const machineId = '30000000-0000-4000-8000-000000000010';
    const jobId = '50000000-0000-4000-8000-000000000010';
    const server = {
      id: 1010, status: 'running' as const, publicIPv4: '203.0.113.110', createActionId: 1710,
      labels: { machine_id: machineId, snapshot_id: '10000000-0000-4000-8000-000000000002' },
    };
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    let resolveCreateAction!: (value: { id: number; status: 'success'; command: string }) => void;
    const getAction = vi.fn(() => new Promise<{ id: number; status: 'success'; command: string }>((resolve) => {
      resolveCreateAction = resolve;
    }));
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const service = createCustomerVpsService({
      db, config: customerConfig,
      hetzner: createMockHetznerClient({
        createServer: vi.fn().mockResolvedValue(server),
        listServersByLabel: vi.fn().mockResolvedValue([]),
        getAction,
        deleteServer,
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => machineId,
      provisioningJobIdFactory: () => jobId,
      tokenFactory: () => ({
        token: 'early-registration-token',
        hash: hashRegistrationToken('early-registration-token'),
        expiresAt: '2026-07-03T01:00:00.000Z',
      }),
      now: () => new Date('2026-07-03T00:10:00.000Z'),
    });

    const provisionPromise = service.provision({ clerkUserId: 'user_10', handle: 'early', runtimeSlot: 'primary' });
    await vi.waitFor(() => expect(getAction).toHaveBeenCalledTimes(1));
    expect(await getProvisioningJob(db, jobId)).toMatchObject({ status: 'running', activationStep: 'creating' });
    await expect(service.register('early-registration-token', {
      machineId, hetznerServerId: 1010, publicIPv4: '203.0.113.110', imageVersion: 'v2',
      bundleSha256: '2'.repeat(64), healthy: true,
    })).resolves.toMatchObject({ registered: true, status: 'running' });
    expect(await getProvisioningJob(db, jobId)).toMatchObject({ status: 'completed', activationStep: 'registered' });
    expect((await db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('machine_id', '=', machineId).executeTakeFirstOrThrow()).released_at)
      .toBe('2026-07-03T00:10:00.000Z');
    resolveCreateAction({ id: 1710, status: 'success', command: 'create_server' });
    await expect(provisionPromise).resolves.toMatchObject({ machineId });
    expect(deleteServer).not.toHaveBeenCalledWith(1010);
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'running' });
  });

  it('persists clean fallback before waiting for a rejected clone to disappear', async () => {
    await readySnapshot('v2', 302);
    const machineId = '30000000-0000-4000-8000-000000000011';
    const jobId = '50000000-0000-4000-8000-000000000011';
    const server = {
      id: 1011, status: 'running' as const, publicIPv4: '203.0.113.111', createActionId: 1711,
      labels: { machine_id: machineId, snapshot_id: '10000000-0000-4000-8000-000000000002' },
    };
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig,
      hetzner: createMockHetznerClient({
        createServer: vi.fn().mockResolvedValue(server),
        listServersByLabel: vi.fn().mockResolvedValue([]),
        getAction: vi.fn().mockResolvedValue({ id: 1711, status: 'error', command: 'create_server' }),
        getServer: vi.fn().mockResolvedValue(server),
      }),
      systemStore: createMockCustomerVpsSystemStore(), machineIdFactory: () => machineId,
      provisioningJobIdFactory: () => jobId, now: () => new Date('2026-07-03T00:10:00.000Z'),
    });

    await service.provision({ clerkUserId: 'user_11', handle: 'fallback', runtimeSlot: 'primary' });
    expect(await getProvisioningJob(db, jobId)).toMatchObject({
      status: 'running', imageSource: 'clean_image', providerCreateActionId: null,
      activationStep: 'fallback_pending', fallbackReason: 'clone_rejected',
    });
  });

  it('uses clean Ubuntu after a definite snapshot clone rejection without masking ambiguous failures', async () => {
    await readySnapshot('v2', 302);
    const createServer = vi.fn()
      .mockRejectedValueOnce(new CustomerVpsError(500, 'snapshot_clone_rejected', 'Provisioning provider unavailable'))
      .mockResolvedValueOnce({ id: 123456, status: 'running', publicIPv4: '203.0.113.10' });
    const hetzner = createMockHetznerClient({ createServer });
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig, hetzner, systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '30000000-0000-4000-8000-000000000003',
      provisioningJobIdFactory: () => '50000000-0000-4000-8000-000000000003',
      now: () => new Date('2026-07-03T00:20:00.000Z'),
    });

    await service.provision({ clerkUserId: 'user_3', handle: 'carol', runtimeSlot: 'primary' });
    expect(createServer).toHaveBeenNthCalledWith(1, expect.objectContaining({ image: 302 }));
    expect(createServer).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ image: expect.anything() }));
    const snapshotUserData = createServer.mock.calls[0]![0].userData;
    const fallbackUserData = createServer.mock.calls[1]![0].userData;
    expect(snapshotUserData).toContain('MATRIX_IMAGE_SOURCE=snapshot');
    expect(fallbackUserData).toContain('MATRIX_IMAGE_SOURCE=clean_image');
    expect(fallbackUserData).toContain('MATRIX_SNAPSHOT_SOURCE_VERSION=');
    expect(fallbackUserData).not.toContain('MATRIX_IMAGE_SOURCE=snapshot');
    expect(await getProvisioningJob(db, '50000000-0000-4000-8000-000000000003')).toMatchObject({
      status: 'completed', imageSource: 'clean_image', fallbackReason: 'clone_rejected',
    });
  });

  it('records clean fallback creation while the provider action is still running', async () => {
    vi.useFakeTimers();
    await readySnapshot('v2', 302);
    const machineId = '30000000-0000-4000-8000-000000000023';
    const jobId = '50000000-0000-4000-8000-000000000023';
    const createServer = vi.fn()
      .mockRejectedValueOnce(new CustomerVpsError(
        500, 'snapshot_clone_rejected', 'Provisioning provider unavailable',
      ))
      .mockResolvedValueOnce({
        id: 1023, status: 'initializing', publicIPv4: '203.0.113.123', createActionId: 1723,
      });
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
        GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
        S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
      }),
      hetzner: createMockHetznerClient({
        createServer,
        getAction: vi.fn().mockResolvedValue({ id: 1723, status: 'running', command: 'create_server' }),
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => machineId,
      provisioningJobIdFactory: () => jobId,
      now: () => new Date('2026-07-03T00:20:00.000Z'),
    });

    const provisioning = service.provision({
      clerkUserId: 'user_23', handle: 'fallback-running', runtimeSlot: 'primary',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await provisioning;

    await expect(getProvisioningJob(db, jobId)).resolves.toMatchObject({
      status: 'running', imageSource: 'clean_image', activationStep: 'creating',
      providerCreateActionId: 1723, fallbackReason: 'clone_rejected',
    });
  });

  it('keeps an ambiguous snapshot create pending and adopts the exact labeled server on retry', async () => {
    await readySnapshot('v2', 302);
    const machineId = '30000000-0000-4000-8000-000000000012';
    const jobId = '50000000-0000-4000-8000-000000000012';
    let adoptedStatus: 'initializing' | 'running' = 'initializing';
    const adoptedServer = () => ({
      id: 1012,
      status: adoptedStatus,
      publicIPv4: '203.0.113.112',
      labels: {
        machine_id: machineId,
        snapshot_id: '10000000-0000-4000-8000-000000000002',
      },
    });
    let currentNow = new Date('2026-07-03T00:20:00.000Z');
    let lookupCount = 0;
    const createServer = vi.fn().mockRejectedValue(new Error('provider response lost'));
    const customerConfig = loadCustomerVpsConfig({
      PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
      MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
      GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
      GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
      S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
    });
    const service = createCustomerVpsService({
      db, config: customerConfig,
      hetzner: createMockHetznerClient({
        createServer,
        listServersByLabel: vi.fn(async () => (++lookupCount === 1 ? [] : [adoptedServer()])),
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => machineId,
      provisioningJobIdFactory: () => jobId,
      now: () => currentNow,
    });

    await service.provision({ clerkUserId: 'user_12', handle: 'ambiguous', runtimeSlot: 'primary' });
    await expect(getProvisioningJob(db, jobId)).resolves.toMatchObject({
      status: 'running', imageSource: 'snapshot', activationStep: 'creating',
    });
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ status: 'provisioning' });

    currentNow = new Date('2026-07-03T00:26:00.000Z');
    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ completed: 0, failed: 0 });
    await expect(getProvisioningJob(db, jobId)).resolves.toMatchObject({
      status: 'running', activationStep: 'creating',
    });
    adoptedStatus = 'running';
    currentNow = new Date('2026-07-03T00:32:00.000Z');
    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(createServer).toHaveBeenCalledTimes(1);
    await expect(getProvisioningJob(db, jobId)).resolves.toMatchObject({ status: 'completed' });
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ hetznerServerId: 1012 });
  });

  it('keeps an ambiguous clean fallback create pending and adopts it without a third create', async () => {
    await readySnapshot('v2', 302);
    const machineId = '30000000-0000-4000-8000-000000000013';
    const jobId = '50000000-0000-4000-8000-000000000013';
    const adoptedServer = {
      id: 1013,
      status: 'running' as const,
      publicIPv4: '203.0.113.113',
      labels: { machine_id: machineId },
    };
    let currentNow = new Date('2026-07-03T00:20:00.000Z');
    let lookupCount = 0;
    const createServer = vi.fn()
      .mockRejectedValueOnce(new CustomerVpsError(
        500, 'snapshot_clone_rejected', 'Provisioning provider unavailable',
      ))
      .mockRejectedValueOnce(new Error('clean provider response lost'));
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET: 'platform-secret', CUSTOMER_VPS_IMAGE_VERSION: 'v2',
        MATRIX_HOST_BUNDLE_URL: 'https://bundles.example/system-bundles/v2/matrix-host-bundle.tar.gz',
        GOLDEN_SNAPSHOTS_ENABLED: 'true', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
        GOLDEN_SNAPSHOT_REGION: 'eu-central', HETZNER_SERVER_TYPE: 'cpx22',
        S3_ACCESS_KEY_ID: 'access-key', S3_SECRET_ACCESS_KEY: 'secret-key', S3_ENDPOINT: 'https://r2.example',
      }),
      hetzner: createMockHetznerClient({
        createServer,
        listServersByLabel: vi.fn(async () => (++lookupCount === 1 ? [] : [adoptedServer])),
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => machineId,
      provisioningJobIdFactory: () => jobId,
      now: () => currentNow,
    });

    await service.provision({ clerkUserId: 'user_13', handle: 'clean-ambiguous', runtimeSlot: 'primary' });
    await expect(getProvisioningJob(db, jobId)).resolves.toMatchObject({
      status: 'running', imageSource: 'clean_image', activationStep: 'fallback_pending',
    });

    currentNow = new Date('2026-07-03T00:26:00.000Z');
    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(createServer).toHaveBeenCalledTimes(2);
    await expect(getUserMachine(db, machineId)).resolves.toMatchObject({ hetznerServerId: 1013 });
  });
});
