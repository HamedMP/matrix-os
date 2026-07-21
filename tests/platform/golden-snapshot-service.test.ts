import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import { createGoldenSnapshotService } from '../../packages/platform/src/golden-snapshot-service.js';
import {
  claimGoldenSnapshotBuild,
  enqueueGoldenSnapshotBuild,
  getGoldenSnapshot,
  getGoldenSnapshotBuild,
  listCallbackWaitGoldenSnapshotBuildIds,
  listRunnableGoldenSnapshotBuildIds,
  listPendingGoldenSnapshotCleanup,
  retireGoldenSnapshot,
  revokeGoldenSnapshotBaseGeneration,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import type { GoldenSnapshotRuntimeConfig } from '../../packages/platform/src/golden-snapshot-schema.js';
import { createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const compatibility = {
  provider: 'hetzner' as const,
  architecture: 'x86' as const,
  region: 'eu-central',
  baseImage: 'ubuntu-24.04',
  baseGeneration: 'ubuntu-24.04-v1',
  bootMode: 'bios' as const,
  activationAbi: 'host-v1',
  minimumDiskGb: 40,
};
const config: GoldenSnapshotRuntimeConfig = {
  enabled: false,
  buildsEnabled: true,
  rolloutPercent: 0,
  compatibility,
  maxBuildAttempts: 5,
  maxConcurrentBuilds: 2,
  buildLeaseMs: 300_000,
  provisioningLeaseMs: 600_000,
  reconciliationBatchSize: 25,
  retentionLimit: 5,
  freshnessMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  testModeTtlMs: 24 * 60 * 60 * 1000,
  auditRetentionMs: 90 * 24 * 60 * 60 * 1000,
};
const validationEvidence = {
  exactBundle: true as const,
  healthy: true as const,
  freshActivation: true as const,
  uniqueMachineId: true as const,
  uniqueSshHostKey: true as const,
  forbiddenStateAbsent: true as const,
};
const builderFingerprints = {
  builderMachineIdSha256: 'a'.repeat(64),
  builderSshHostKeySha256: 'b'.repeat(64),
};
const validationFingerprints = {
  validationMachineIdSha256: 'c'.repeat(64),
  validationSshHostKeySha256: 'd'.repeat(64),
};
const secondValidationFingerprints = {
  validationMachineIdSha256: 'e'.repeat(64),
  validationSshHostKeySha256: 'f'.repeat(64),
};

describe('golden snapshot build service', () => {
  let db: PlatformDB;
  let template: string;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    template = await readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8');
    await upsertHostBundleRelease(db, {
      version: 'v1', gitCommit: '1111111', buildTime: '2026-07-01T00:00:00.000Z',
      bundleKey: 'system-bundles/v1/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v1/matrix-host-bundle.tar.gz.sha256',
      sha256: '1'.repeat(64), size: 100, createdAt: '2026-07-01T00:00:00.000Z',
    });
  });

  afterEach(async () => destroyTestPlatformDb(db));

  it('binds the validated image architecture as a value in the readiness fence', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-service.ts', 'utf8');
    expect(source).not.toContain("whereRef('image_architecture', '=', 'architecture')");
    expect(source).toContain(
      ".where('image_architecture', '=', snapshot.compatibility.architecture)",
    );
  });

  it('conditions quarantine writes on the lifecycle phase observed by the worker', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-service.ts', 'utf8');
    expect(source).toContain(".where('phase', '=', expectedPhase)");
    expect(source).toContain(".where('status', '=', 'running')");
  });

  it('normalizes persisted release digests when loading immutable provenance', async () => {
    const { enqueued, service } = await setup();
    await db.executor.updateTable('host_bundle_releases').set({ sha256: 'A'.repeat(64) })
      .where('version', '=', 'v1').execute();
    await db.executor.updateTable('golden_snapshots').set({ bundle_sha256: 'a'.repeat(64) })
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('builder_boot');
  });

  async function setup(
    overrides: Parameters<typeof createMockHetznerClient>[0] = {},
    now: () => string = () => '2026-07-03T00:01:00.000Z',
  ) {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000001',
      buildId: '20000000-0000-4000-8000-000000000001',
      now: '2026-07-03T00:00:00.000Z',
    });
    await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:00:01.000Z', '2026-07-03T00:10:01.000Z', 5,
    );
    const hetzner = createMockHetznerClient({
      createServer: vi.fn()
        .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} })
        .mockResolvedValueOnce({ id: 102, status: 'running', createActionId: 202, labels: {} })
        .mockResolvedValueOnce({ id: 103, status: 'running', createActionId: 203, labels: {} }),
      getServer: vi.fn().mockResolvedValue({ id: 101, status: 'off', labels: {} }),
      createSnapshot: vi.fn().mockResolvedValue({
        image: { id: 301, status: 'available', type: 'snapshot', architecture: 'x86', diskGb: 40, labels: {}, deleteProtected: false },
        action: { id: 401, status: 'success', command: 'create_image' },
      }),
      getImage: vi.fn().mockResolvedValue({
        id: 301, status: 'available', type: 'snapshot', architecture: 'x86', diskGb: 40, labels: {}, deleteProtected: false,
      }),
      getAction: vi.fn().mockResolvedValue({ id: 401, status: 'success', command: 'create_image' }),
      ...overrides,
    });
    const service = createGoldenSnapshotService({
      db, config, hetzner, builderCloudInitTemplate: template,
      bundleBaseUrl: 'https://bundles.example', callbackBaseUrl: 'https://platform.example',
      tokenFactory: () => 'phase-token-long-enough', now,
    });
    return { enqueued, service, hetzner };
  }

  it('accepts a validation callback after the worker lease expires but before its callback deadline', async () => {
    let currentTime = '2026-07-03T00:01:00.000Z';
    const { enqueued, service } = await setup({}, () => currentTime);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({
      phase: 'validation_boot',
      leaseExpiresAt: '2026-07-03T00:10:01.000Z',
      callbackExpiresAt: '2026-07-03T00:31:00.000Z',
    });

    currentTime = '2026-07-03T00:20:00.000Z';
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    });
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'validating' });
    await service.runBuildStep(enqueued.build.buildId);
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...secondValidationFingerprints,
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({ state: 'ready' });
  });

  it('replays an accepted callback idempotently and rejects event-id payload drift', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    const eventId = '60000000-0000-4000-8000-000000000001';
    const payload = {
      eventId,
      phase: 'sanitized' as const,
      bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64),
      ...builderFingerprints,
    };

    await expect(service.consumeCallback(
      enqueued.build.buildId, 'phase-token-long-enough', payload,
    )).resolves.toBeUndefined();
    await expect(service.consumeCallback(
      enqueued.build.buildId, 'phase-token-long-enough', payload,
    )).resolves.toBeUndefined();
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      ...payload,
      builderMachineIdSha256: '9'.repeat(64),
    })).rejects.toMatchObject({ code: 'rejected' });
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'snapshot_create',
      callbackEventId: eventId,
      callbackOutcome: { accepted: true },
    });

    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: '60000000-0000-4000-8000-000000000002',
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    });
    await expect(service.consumeCallback(
      enqueued.build.buildId, 'phase-token-long-enough', payload,
    )).resolves.toBeUndefined();
  });

  it('never marks a snapshot ready until an independent validation callback succeeds', async () => {
    const { enqueued, service, hetzner } = await setup();

    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('builder_boot');
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({
      callbackExpiresAt: '2026-07-03T00:31:00.000Z',
      providerBuilderActionId: 201,
      providerSnapshotActionId: null,
    });
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'building' });
    expect(hetzner.createServer).toHaveBeenCalledWith(expect.objectContaining({
      image: 'ubuntu-24.04',
      sshKeys: [],
    }));

    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'sanitizing' });

    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_wait');
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'validating' });
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('validation_boot');
    expect(hetzner.createServer).toHaveBeenLastCalledWith(expect.objectContaining({
      image: 301,
      sshKeys: [],
    }));
    const validationCreate = vi.mocked(hetzner.createServer).mock.calls.at(-1)?.[0];
    expect(validationCreate?.userData).toContain('matrix-golden-snapshot-activate');
    expect(validationCreate?.userData).toContain(`MATRIX_BUILDER_MACHINE_ID_SHA256='${builderFingerprints.builderMachineIdSha256}'`);
    expect(validationCreate?.userData).toContain(`MATRIX_BUILDER_SSH_HOST_KEY_SHA256='${builderFingerprints.builderSshHostKeySha256}'`);
    expect(validationCreate?.userData).toContain('--data-binary @/run/matrix-golden-validation.json');
    expect(validationCreate?.userData).toContain('validationStatus=$?');
    expect(validationCreate?.userData?.indexOf('validationStatus=$?'))
      .toBeLessThan(validationCreate?.userData?.indexOf('curl --config -') ?? -1);
    expect(validationCreate?.userData).toContain('exit "$validationStatus"');
    expect(validationCreate?.userData).toContain("permissions: '0600'");
    expect(validationCreate?.userData).toContain('curl --config -');
    expect(validationCreate?.userData).not.toContain('-H "authorization: Bearer $callbackToken"');
    expect(validationCreate?.userData).not.toContain('authorization: Bearer phase-token-long-enough');
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'validating' });

    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    });
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'validating' });
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({
      phase: 'validation_create', validationCloneOrdinal: 2,
      firstValidationMachineIdSha256: validationFingerprints.validationMachineIdSha256,
      firstValidationSshHostKeySha256: validationFingerprints.validationSshHostKeySha256,
    });
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('validation_boot');
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...secondValidationFingerprints,
    });
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'ready', providerImageId: 301 });
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({ status: 'completed' });
    await expect(db.executor.selectFrom('golden_snapshot_audit_events').select('event_type')
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId)
      .where('event_type', 'in', ['snapshot_sanitized', 'snapshot_ready'])
      .orderBy('created_at').execute()).resolves.toEqual([
      { event_type: 'snapshot_sanitized' }, { event_type: 'snapshot_ready' },
    ]);
    const cleanup = await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10);
    expect(cleanup).toHaveLength(3);
    const deleted = new Set<number>();
    vi.mocked(hetzner.getServer).mockImplementation(async (id) => deleted.has(id) ? null : ({
      id,
      status: 'off',
      labels: {
        'matrix.snapshot-build': enqueued.build.buildId,
        'matrix.snapshot-id': enqueued.snapshot.snapshotId,
        'matrix.role': id === 101 ? 'builder' : 'validation',
      },
    }));
    vi.mocked(hetzner.deleteServer).mockImplementation(async (id) => { deleted.add(id); });
    for (const item of cleanup) await service.runCleanupStep(item.cleanupId);
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(3);
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10)).toEqual([]);
  });

  it('rejects final readiness when the base generation is revoked during validation', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await revokeGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, 'base_generation_revoked', '2026-07-03T00:01:30.000Z',
    );

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...secondValidationFingerprints,
    })).rejects.toMatchObject({ code: 'rejected' });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.not.toMatchObject({ state: 'ready' });
  });

  it('fails closed on incomplete validation evidence', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: { ...validationEvidence, forbiddenStateAbsent: false }, ...validationFingerprints,
    })).rejects.toMatchObject({ code: 'rejected' });
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'quarantined' });
    await expect(db.executor.selectFrom('golden_snapshot_audit_events').select(['event_type', 'reason'])
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId)
      .where('event_type', '=', 'snapshot_quarantined').executeTakeFirst())
      .resolves.toEqual({ event_type: 'snapshot_quarantined', reason: 'validation_failed' });
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 301 }),
      ]),
    );
  });

  it('terminally fails exhausted cleanup rows so they cannot starve the queue', async () => {
    const { enqueued, service } = await setup({
      getImage: vi.fn().mockResolvedValue({
        id: 301, status: 'available', type: 'snapshot', architecture: 'x86', diskGb: 40,
        labels: { 'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001' },
        deleteProtected: false,
      }),
      deleteImage: vi.fn().mockResolvedValue(undefined),
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', provider_image_id: 301, provider_image_status: 'available',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await retireGoldenSnapshot(db, enqueued.snapshot.snapshotId, 'revoked', '2026-07-03T00:01:00.000Z');
    const [cleanup] = await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10);
    for (let attempt = 0; attempt < config.maxBuildAttempts; attempt += 1) {
      expect(await service.runCleanupStep(cleanup!.cleanupId)).toBe('pending');
    }
    expect(await db.executor.selectFrom('golden_snapshot_cleanup')
      .select(['status', 'attempts']).where('cleanup_id', '=', cleanup!.cleanupId).executeTakeFirst())
      .toEqual({ status: 'quarantined', attempts: config.maxBuildAttempts });
  });

  it('terminally fails cleanup rows whose final running lease expired after a crash', async () => {
    const { enqueued, service } = await setup();
    await db.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', provider_image_id: 302, provider_image_status: 'available',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await retireGoldenSnapshot(db, enqueued.snapshot.snapshotId, 'revoked', '2026-07-03T00:01:00.000Z');
    const [cleanup] = await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10);
    await db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'running', attempts: config.maxBuildAttempts,
      lease_expires_at: '2026-07-03T00:00:00.000Z',
    }).where('cleanup_id', '=', cleanup!.cleanupId).execute();

    expect(await service.runCleanupStep(cleanup!.cleanupId)).toBe('quarantined');
    expect(await db.executor.selectFrom('golden_snapshot_cleanup')
      .select(['status', 'attempts', 'last_error_code'])
      .where('cleanup_id', '=', cleanup!.cleanupId).executeTakeFirst()).toEqual({
      status: 'quarantined', attempts: config.maxBuildAttempts, last_error_code: 'retry_budget_exhausted',
    });
  });

  it('adopts an exact builder before consuming an early sanitized callback', async () => {
    const { enqueued, service } = await setup({
      createServer: vi.fn().mockRejectedValueOnce(new Error('synthetic timeout')),
      listServersByLabel: vi.fn().mockResolvedValue([{
        id: 101, status: 'running', createActionId: 201,
        labels: {
          'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
          'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
          'matrix.role': 'builder',
        },
      }]),
    });
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'snapshot_create', providerBuilderId: 101, providerBuilderActionId: 201,
    });
  });

  it('adopts an exact validation clone before consuming an early validated callback', async () => {
    const createServer = vi.fn()
      .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} })
      .mockRejectedValueOnce(new Error('synthetic timeout'))
      .mockResolvedValueOnce({ id: 103, status: 'running', createActionId: 203, labels: {} });
    const { enqueued, service } = await setup({
      createServer,
      listServersByLabel: vi.fn().mockResolvedValue([{
        id: 102, status: 'running', createActionId: 202,
        labels: {
          'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
          'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
          'matrix.role': 'validation',
          'matrix.validation-ordinal': '1',
        },
      }]),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({ state: 'validating' });
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('validation_boot');
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...secondValidationFingerprints,
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({ state: 'ready' });
  });

  it('rejects validation identity hashes that match the builder', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), evidence: validationEvidence,
      validationMachineIdSha256: builderFingerprints.builderMachineIdSha256,
      validationSshHostKeySha256: builderFingerprints.builderSshHostKeySha256,
    })).rejects.toMatchObject({ code: 'rejected' });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'validation_identity_reused',
    });
  });

  it('rejects a second validation clone that reuses the first clone identity', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    })).rejects.toMatchObject({ code: 'rejected' });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'validation_identity_reused',
    });
  });

  it('reconciles an ambiguous builder create by exact immutable labels without creating twice', async () => {
    const createServer = vi.fn().mockRejectedValueOnce(new Error('synthetic timeout'));
    const { enqueued, service, hetzner } = await setup({
      createServer,
      listServersByLabel: vi.fn().mockResolvedValue([{ id: 101, status: 'running', createActionId: 201, labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
        'matrix.role': 'builder',
      } }]),
    });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('builder_boot');
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(hetzner.listServersByLabel).toHaveBeenCalledWith(
      'matrix.snapshot-build=20000000-0000-4000-8000-000000000001,matrix.role=builder',
    );
  });

  it('continues bounded exact-label cleanup discovery after builder quarantine', async () => {
    let currentNow = '2026-07-03T00:01:00.000Z';
    const listServersByLabel = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 909, status: 'running', labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
        'matrix.role': 'builder',
      } }]);
    const { enqueued, service } = await setup({
      createServer: vi.fn().mockRejectedValueOnce(new Error('synthetic timeout')),
      listServersByLabel,
    }, () => currentNow);

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    currentNow = '2026-07-03T00:31:01.000Z';
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('recovery window');
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({
      state: 'quarantined', failureCode: 'builder_create_unresolved',
    });
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({
      status: 'failed', pendingOperation: `builder:${enqueued.build.buildId}`,
    });

    currentNow = '2026-07-03T00:32:00.000Z';
    await expect(service.runOrphanReconciliationStep(enqueued.build.buildId)).resolves.toBe('queued');
    expect(await listPendingGoldenSnapshotCleanup(db, currentNow, 10)).toEqual([
      expect.objectContaining({ resourceType: 'builder_server', providerResourceId: 909 }),
    ]);
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({ pendingOperation: null });
  });

  it('quarantines an unresolved validation clone after its bounded recovery window', async () => {
    let currentNow = '2026-07-03T00:01:00.000Z';
    const createServer = vi.fn()
      .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} })
      .mockRejectedValueOnce(new Error('synthetic timeout'));
    const { enqueued, service } = await setup({
      createServer,
      listServersByLabel: vi.fn().mockResolvedValue([]),
    }, () => currentNow);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    currentNow = '2026-07-03T00:31:01.000Z';
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('recovery window');
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({
      state: 'quarantined', failureCode: 'validation_create_unresolved',
    });
  });

  it('deletes a retired image using snapshot-scoped provenance and commits completion atomically', async () => {
    const deleted = new Set<number>();
    const { enqueued, service, hetzner } = await setup({
      getImage: vi.fn(async (id: number) => deleted.has(id) ? null : ({
        id, status: 'available', type: 'snapshot', architecture: 'x86', diskGb: 40,
        deleteProtected: false, labels: { 'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001' },
      })),
      deleteImage: vi.fn(async (id: number) => { deleted.add(id); }),
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', provider_image_id: 301, provider_image_status: 'available',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    expect(await retireGoldenSnapshot(db, enqueued.snapshot.snapshotId, 'revoked', '2026-07-03T00:01:00.000Z')).toBe(true);
    const [cleanup] = await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10);
    expect(await service.runCleanupStep(cleanup!.cleanupId)).toBe('deleted');
    expect(hetzner.deleteImage).toHaveBeenCalledWith(301);
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'deleted' });
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:03:00.000Z', 10)).toEqual([]);
  });

  it('adopts exactly one labeled snapshot after an ambiguous create response', async () => {
    const image = {
      id: 301, status: 'available' as const, type: 'snapshot' as const,
      architecture: 'x86' as const, diskGb: 80, deleteProtected: false,
      labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
        'matrix.role': 'builder',
      },
    };
    const { enqueued, service, hetzner } = await setup({
      createSnapshot: vi.fn().mockRejectedValueOnce(new Error('synthetic timeout')),
      listImagesByLabel: vi.fn().mockResolvedValue([image]),
      getImage: vi.fn().mockResolvedValue(image),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('validation_boot');
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
    expect(hetzner.listImagesByLabel).toHaveBeenCalledWith(
      'matrix.snapshot-build=20000000-0000-4000-8000-000000000001,matrix.snapshot-id=10000000-0000-4000-8000-000000000001',
    );
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({
      providerImageId: 301, imageDiskGb: 80,
    });
  });

  it('keeps callback-wait phases runnable so lost callbacks are bounded', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    expect(await listRunnableGoldenSnapshotBuildIds(db, '2026-07-03T00:02:00.000Z', 10))
      .not.toContain(enqueued.build.buildId);
    expect(await listCallbackWaitGoldenSnapshotBuildIds(db, 10))
      .toContain(enqueued.build.buildId);
  });

  it('does not clone from an image until its snapshot action is confirmed successful', async () => {
    const { enqueued, service, hetzner } = await setup({ getAction: vi.fn().mockResolvedValue(null) });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_wait');
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_wait');
    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded hard power-off fallback when graceful shutdown stalls', async () => {
    let currentTime = '2026-07-03T00:01:00.000Z';
    const { enqueued, service, hetzner } = await setup({
      getServer: vi.fn().mockResolvedValue({ id: 101, status: 'running', labels: {} }),
    }, () => currentTime);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_create');
    expect(hetzner.shutdownServer).toHaveBeenCalledWith(101);
    currentTime = '2026-07-03T00:03:01.000Z';
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_create');
    expect(hetzner.powerOffServer).toHaveBeenCalledWith(101);
  });

  it('rotates pending orphan probes by advancing their scheduling timestamp', async () => {
    let currentTime = '2026-07-03T00:01:00.000Z';
    const { enqueued, service } = await setup({
      createServer: vi.fn().mockRejectedValueOnce(new Error('synthetic timeout')),
      listServersByLabel: vi.fn().mockResolvedValue([]),
    }, () => currentTime);
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    currentTime = '2026-07-03T00:31:01.000Z';
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('recovery window');
    currentTime = '2026-07-03T00:32:00.000Z';
    await expect(service.runOrphanReconciliationStep(enqueued.build.buildId)).resolves.toBe('pending');
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      updatedAt: currentTime,
    });
  });

  it('accepts the provider image disk requirement and defers capacity checks to selection', async () => {
    const { enqueued, service } = await setup({
      createSnapshot: vi.fn().mockResolvedValue({
        image: { id: 301, status: 'available', type: 'snapshot', architecture: 'x86', diskGb: 80, labels: {}, deleteProtected: false },
        action: { id: 401, status: 'success', command: 'create_image' },
      }),
      getImage: vi.fn().mockResolvedValue({
        id: 301, status: 'available', type: 'snapshot', architecture: 'x86', diskGb: 80, labels: {}, deleteProtected: false,
      }),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_wait');
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('validation_boot');
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ imageDiskGb: 80, state: 'validating' });
  });
});
