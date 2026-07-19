import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import { insertProvisioningJob, sealProvisioningPayload, getProvisioningJob } from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import {
  chooseProvisioningImage,
  chooseRecoveryImage,
  fallbackProvisioningImage,
} from '../../packages/platform/src/golden-snapshot-activation.js';
import {
  advanceGoldenSnapshot,
  claimGoldenSnapshotBuild,
  enqueueGoldenSnapshotBuild,
  markGoldenSnapshotReady,
  recordGoldenSnapshotProviderImage,
  retryGoldenSnapshotBuild,
  revokeGoldenSnapshot,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import type { GoldenSnapshotRuntimeConfig } from '../../packages/platform/src/golden-snapshot-schema.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';

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
  afterEach(async () => destroyTestPlatformDb(db));

  async function readySnapshot(version: 'v1' | 'v2', imageId: number) {
    const suffix = version === 'v1' ? '1' : '2';
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: version, compatibility,
      snapshotId: `10000000-0000-4000-8000-00000000000${suffix}`,
      buildId: `20000000-0000-4000-8000-00000000000${suffix}`,
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

  it('uses only a compatible older snapshot and records that exact update is required', async () => {
    await readySnapshot('v1', 301);
    const selected = await chooseProvisioningImage(db, config, {
      jobId: '50000000-0000-4000-8000-000000000001', machineId: '30000000-0000-4000-8000-000000000001',
      targetBundleVersion: 'v2', serverType: 'cpx22', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000001', now: '2026-07-03T00:01:00.000Z',
    });
    expect(selected).toMatchObject({ imageSource: 'snapshot', providerImageId: 301, exact: false, requiresExactUpdate: true });
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
    }).where('job_id', '=', '50000000-0000-4000-8000-000000000001').execute();
    const createServer = vi.fn().mockResolvedValue({
      id: 1201, status: 'running', publicIPv4: '203.0.113.201',
    });
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
        createServer, deleteServer,
        listServersByLabel: vi.fn().mockResolvedValue([staleServer]),
        getServer: vi.fn().mockResolvedValue(null),
      }),
      systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    });

    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(deleteServer).toHaveBeenCalledWith(1200);
    expect(createServer).toHaveBeenCalledWith(expect.not.objectContaining({ image: 302 }));
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

  it('accepts metadata-free clean-image registration without treating the zero digest as provenance', async () => {
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
      }),
      hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date('2026-07-03T00:10:00.000Z'),
    });

    await expect(service.register('metadata-free-token', {
      machineId, hetznerServerId: 902, publicIPv4: '203.0.113.92', imageVersion: 'v2',
    })).resolves.toMatchObject({ registered: true, status: 'running' });
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
      callback_expires_at: '2026-07-03T00:09:00.000Z', pending_operation: 'stale',
    }).where('build_id', '=', enqueued.build.buildId).execute();

    expect(await retryGoldenSnapshotBuild(db, enqueued.build.buildId, '2026-07-03T00:10:00.000Z')).toBe(true);
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
      .select(['resource_type', 'provider_resource_id', 'reason']).orderBy('provider_resource_id').execute()).toEqual([
      { resource_type: 'builder_server', provider_resource_id: 801, reason: 'operator_retry' },
      { resource_type: 'validation_server', provider_resource_id: 803, reason: 'operator_retry' },
    ]);
  });

  it('enforces exact bundle provenance when a snapshot recovery registers', async () => {
    await readySnapshot('v1', 301);
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

  it('passes the leased exact image into customer creation, then releases the lease with job completion', async () => {
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

    await service.provision({ clerkUserId: 'user_2', handle: 'bob', runtimeSlot: 'primary' });

    expect(hetzner.createServer).toHaveBeenCalledWith(expect.objectContaining({ image: 302 }));
    expect(await getProvisioningJob(db, '50000000-0000-4000-8000-000000000002')).toMatchObject({
      status: 'running', imageSource: 'snapshot', providerCreateActionId: 777,
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
    expect(lease.released_at).toBe('2026-07-03T00:20:01.000Z');
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
    expect(await getUserMachine(db, '30000000-0000-4000-8000-000000000002')).toMatchObject({
      sourceSnapshotId: '10000000-0000-4000-8000-000000000002',
      sourceBaseGeneration: 'ubuntu-24.04-v1',
      targetBundleVersion: 'v2',
      targetBundleSha256: '2'.repeat(64),
    });
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
});
