import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  createGoldenSnapshotService,
  GoldenSnapshotCallbackSchema,
  normalizeCleanupProviderResourceId,
} from '../../packages/platform/src/golden-snapshot-service.js';
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
import {
  CustomerVpsError,
  DefinitiveProviderRejectionError,
} from '../../packages/platform/src/customer-vps-errors.js';
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
  callbackDeadlineMs: 30 * 60 * 1000,
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

  it('normalizes Postgres BIGINT cleanup resource IDs before provider calls', () => {
    expect(normalizeCleanupProviderResourceId('415673827')).toBe(415673827);
    expect(() => normalizeCleanupProviderResourceId('9007199254740992')).toThrow();
  });

  it('accepts the bounded validation failure stages', () => {
    for (const stage of [
      'activation_preflight_evidence',
      'activation_preflight_forbidden_state',
      'activation_preflight_runtime_state',
      'activation_preflight_owner_state',
      'activation_preflight_root_ssh_state',
      'activation_preflight_root_local_state',
      'activation_preflight_log_state',
      'activation_preflight_cloud_init',
      'activation_preflight_container_state',
      'validation_check_exact_bundle',
      'validation_check_health',
      'validation_check_fresh_activation',
      'validation_check_machine_id',
      'validation_check_ssh_host_key',
      'validation_check_forbidden_state',
    ]) {
      expect(GoldenSnapshotCallbackSchema.safeParse({
        eventId: randomUUID(), phase: 'failed', role: 'validation', stage,
        bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      }).success).toBe(true);
    }
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
    runtimeConfig: GoldenSnapshotRuntimeConfig = config,
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
    const deletedServers = new Set<number>();
    const hetzner = createMockHetznerClient({
      createServer: vi.fn()
        .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} })
        .mockResolvedValueOnce({ id: 102, status: 'running', createActionId: 202, labels: {} })
        .mockResolvedValueOnce({ id: 103, status: 'running', createActionId: 203, labels: {} }),
      getServer: vi.fn(async (id: number) => deletedServers.has(id) ? null : ({
        id,
        status: 'off',
        labels: {
          'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
          'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
          'matrix.role': id === 101 ? 'builder' : 'validation',
        },
      })),
      deleteServer: vi.fn(async (id: number) => { deletedServers.add(id); }),
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
      db, config: runtimeConfig, hetzner, builderCloudInitTemplate: template,
      bundleBaseUrl: 'https://bundles.example', callbackBaseUrl: 'https://platform.example',
      tokenFactory: () => 'phase-token-long-enough', now,
    });
    return { enqueued, service, hetzner };
  }

  it('uses a bounded configured deadline for the complete external callback phase', async () => {
    const runtimeConfig = {
      ...config,
      callbackDeadlineMs: 45 * 60 * 1000,
    } as GoldenSnapshotRuntimeConfig;
    const { enqueued, service } = await setup({}, undefined, runtimeConfig);

    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('builder_boot');
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      callbackExpiresAt: '2026-07-03T00:46:00.000Z',
    });
  });

  it('quarantines and cleans up a builder that reports a coarse lifecycle failure', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    const payload = {
      eventId: randomUUID(),
      phase: 'failed' as const,
      role: 'builder' as const,
      stage: 'sanitization_residue' as const,
      bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64),
    };

    await expect(service.consumeCallback(
      enqueued.build.buildId, 'phase-token-long-enough', payload,
    )).resolves.toBeUndefined();
    await expect(service.consumeCallback(
      enqueued.build.buildId, 'phase-token-long-enough', payload,
    )).resolves.toBeUndefined();
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'builder_sanitization_residue_failed',
    });
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'failed', status: 'failed', lastErrorCode: 'builder_sanitization_residue_failed',
    });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ resourceType: 'builder_server', providerResourceId: 101 }),
      ]));
  });

  it('quarantines and cleans up a validation clone that reports a coarse lifecycle failure', async () => {
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
      phase: 'failed', role: 'validation', stage: 'checks',
      bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'validation_checks_failed',
    });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ resourceType: 'validation_server', providerResourceId: 102 }),
        expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 301 }),
      ]));
  });

  async function confirmFirstValidationCleanup(buildId: string, at = '2026-07-03T00:01:30.000Z') {
    await db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'completed', completed_at: at,
    }).where('build_id', '=', buildId).where('resource_type', '=', 'validation_server')
      .where('completed_at', 'is', null).execute();
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
    await confirmFirstValidationCleanup(enqueued.build.buildId, currentTime);
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
    await expect(service.consumeCallback(
      enqueued.build.buildId, 'different-phase-token', payload,
    )).rejects.toMatchObject({ code: 'unauthorized' });
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
      serverType: 'cx23',
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
      serverType: 'cx23',
      sshKeys: [],
    }));
    const validationCreate = vi.mocked(hetzner.createServer).mock.calls.at(-1)?.[0];
    expect(() => parseYaml(validationCreate?.userData ?? '')).not.toThrow();
    expect(parseYaml(validationCreate?.userData ?? '')).toMatchObject({
      write_files: [expect.objectContaining({
        path: '/run/matrix-golden-snapshot-callback-token',
      })],
      runcmd: [expect.stringContaining('matrix-golden-snapshot-activate validation')],
    });
    expect(validationCreate?.userData).toContain('matrix-golden-snapshot-activate');
    expect(validationCreate?.userData).toContain(`MATRIX_BUILDER_MACHINE_ID_SHA256='${builderFingerprints.builderMachineIdSha256}'`);
    expect(validationCreate?.userData).toContain(`MATRIX_BUILDER_SSH_HOST_KEY_SHA256='${builderFingerprints.builderSshHostKeySha256}'`);
    expect(validationCreate?.userData).toContain('--data-binary @/run/matrix-golden-validation.json');
    expect(validationCreate?.userData).toContain('validationStatus=$?');
    expect(validationCreate?.userData).toContain('validation_check_exact_bundle');
    expect(validationCreate?.userData).toContain('validation_check_health');
    expect(validationCreate?.userData).toContain('validation_check_fresh_activation');
    expect(validationCreate?.userData).toContain('validation_check_machine_id');
    expect(validationCreate?.userData).toContain('validation_check_ssh_host_key');
    expect(validationCreate?.userData).toContain('validation_check_forbidden_state');
    expect(validationCreate?.userData).toContain('if [ "$validationStatus" -ne 0 ]; then');
    expect(validationCreate?.userData?.indexOf('validationStatus=$?'))
      .toBeLessThan(validationCreate?.userData?.lastIndexOf('curl --config -') ?? -1);
    expect(validationCreate?.userData).toContain('exit "$validationStatus"');
    expect(validationCreate?.userData).toContain('"phase":"failed"');
    expect(validationCreate?.userData).toContain('"role":"validation"');
    expect(validationCreate?.userData).toContain('"stage":"%s"');
    expect(validationCreate?.userData).toContain('"$failureStage"');
    expect(validationCreate?.userData).toContain('trap reportFailure EXIT');
    expect(validationCreate?.userData).not.toContain('trap reportFailure ERR');
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
    await confirmFirstValidationCleanup(enqueued.build.buildId);
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
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({ resourceType: 'validation_server' });
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
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(2);
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10)).toEqual([]);
  });

  it('records builder boot evidence before accepting sanitation', async () => {
    const { enqueued, service, hetzner } = await setup();
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('builder_boot');
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: '60000000-0000-4000-8000-000000000060',
      phase: 'builder_booted', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      healthy: true, ...builderFingerprints,
    })).resolves.toBeUndefined();
    expect(hetzner.getAction).toHaveBeenCalledWith(201);
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId))
      .resolves.toMatchObject({ state: 'sanitizing' });
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: '60000000-0000-4000-8000-000000000061',
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      ...builderFingerprints,
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId))
      .resolves.toMatchObject({ phase: 'snapshot_create' });
  });

  it('quarantines sanitation when the builder identity changes after boot', async () => {
    const { enqueued, service } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: '60000000-0000-4000-8000-000000000062',
      phase: 'builder_booted', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      healthy: true, ...builderFingerprints,
    });

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: '60000000-0000-4000-8000-000000000063',
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      builderMachineIdSha256: 'c'.repeat(64),
      builderSshHostKeySha256: builderFingerprints.builderSshHostKeySha256,
    })).rejects.toThrow('rejected');
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'builder_identity_changed',
    });
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      builderMachineIdSha256: builderFingerprints.builderMachineIdSha256,
      builderSshHostKeySha256: builderFingerprints.builderSshHostKeySha256,
      status: 'failed',
    });
  });

  it('quarantines a successful builder callback when its create action failed', async () => {
    const { enqueued, service } = await setup({
      getAction: vi.fn().mockResolvedValue({ id: 201, status: 'error', command: 'create_server' }),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'sanitized', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), ...builderFingerprints,
    })).rejects.toThrow('rejected');
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'builder_create_action_failed',
    });
  });

  it('quarantines a validation callback when its create action failed', async () => {
    const { enqueued, service } = await setup({
      getAction: vi.fn(async (id: number) => ({
        id,
        status: id === 202 ? 'error' as const : 'success' as const,
        command: id === 401 ? 'create_image' : 'create_server',
      })),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'sanitized', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'validated', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), evidence: validationEvidence, ...validationFingerprints,
    })).rejects.toThrow('rejected');
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'validation_create_action_failed',
    });
  });

  it('rechecks the exact provider image before the second validator can mark it ready', async () => {
    const { enqueued, service, hetzner } = await setup();
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'sanitized', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'validated', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), evidence: validationEvidence, ...validationFingerprints,
    });
    await confirmFirstValidationCleanup(enqueued.build.buildId);
    await service.runBuildStep(enqueued.build.buildId);
    vi.mocked(hetzner.getImage).mockResolvedValueOnce(null);

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'validated', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), evidence: validationEvidence, ...secondValidationFingerprints,
    })).rejects.toThrow('rejected');
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'image_unavailable',
    });
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
    await confirmFirstValidationCleanup(enqueued.build.buildId);
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
      .resolves.toEqual({
        event_type: 'snapshot_quarantined',
        reason: 'validation_check_forbidden_state_failed',
      });
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
    await confirmFirstValidationCleanup(enqueued.build.buildId);
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
    await confirmFirstValidationCleanup(enqueued.build.buildId);
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

  it('releases builder capacity before creating the first validation clone', async () => {
    const deleted = new Set<number>();
    const { enqueued, service, hetzner } = await setup({
      getServer: vi.fn(async (id: number) => deleted.has(id) ? null : ({
        id,
        status: 'off',
        labels: {
          'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
          'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
          'matrix.role': id === 101 ? 'builder' : 'validation',
        },
      })),
      deleteServer: vi.fn(async (id: number) => { deleted.add(id); }),
    }, undefined, { ...config, maxConcurrentBuilds: 1 });

    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_wait');

    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('validation_boot');
    expect(hetzner.deleteServer).toHaveBeenCalledWith(101);
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({
      phase: 'validation_boot',
      providerBuilderId: null,
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
    expect(hetzner.createServer).toHaveBeenLastCalledWith(expect.objectContaining({ image: 301 }));
  });

  it('quarantines a build when deferred builder cleanup becomes terminal', async () => {
    const builder = {
      id: 101,
      status: 'off' as const,
      labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
        'matrix.role': 'builder',
      },
    };
    const { enqueued, service } = await setup({
      getServer: vi.fn().mockResolvedValue(builder),
      deleteServer: vi.fn().mockResolvedValue(undefined),
    });

    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'sanitized', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('snapshot_wait');
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('validation_create');

    await db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'quarantined', attempts: config.maxBuildAttempts,
      lease_expires_at: null, last_error_code: 'retry_budget_exhausted',
    }).where('build_id', '=', enqueued.build.buildId)
      .where('resource_type', '=', 'builder_server').executeTakeFirstOrThrow();

    await expect(service.runBuildStep(enqueued.build.buildId))
      .rejects.toThrow('builder cleanup was unsafe');
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'failed', status: 'failed', lastErrorCode: 'builder_cleanup_unsafe',
    });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'builder_cleanup_unsafe',
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

  it('accepts a callback after the worker adopts an exact labeled builder without an action id', async () => {
    const labels = {
      'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
      'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
      'matrix.role': 'builder',
    };
    const adopted = { id: 101, status: 'running' as const, labels };
    const { enqueued, service } = await setup({
      createServer: vi.fn().mockRejectedValueOnce(new Error('synthetic timeout')),
      listServersByLabel: vi.fn().mockResolvedValue([adopted]),
      getServer: vi.fn().mockResolvedValue(adopted),
    });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('builder_boot');
    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'sanitized', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), ...builderFingerprints,
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'snapshot_create', providerBuilderId: 101, providerBuilderActionId: null,
    });
  });

  it('accepts a callback after the worker adopts an exact labeled validator without an action id', async () => {
    const labels = {
      'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
      'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
      'matrix.role': 'validation',
      'matrix.validation-ordinal': '1',
    };
    const adopted = { id: 102, status: 'running' as const, labels };
    const deleted = new Set<number>();
    const builder = {
      id: 101,
      status: 'off' as const,
      labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
        'matrix.role': 'builder',
      },
    };
    const createServer = vi.fn()
      .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} })
      .mockRejectedValueOnce(new Error('synthetic timeout'));
    const { enqueued, service } = await setup({
      createServer,
      listServersByLabel: vi.fn().mockResolvedValue([adopted]),
      getServer: vi.fn(async (id: number) => deleted.has(id)
        ? null
        : id === builder.id ? builder : adopted),
      deleteServer: vi.fn(async (id: number) => { deleted.add(id); }),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'sanitized', bundleVersion: 'v1',
      bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('validation_boot');

    await expect(service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(), phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
      evidence: validationEvidence, ...validationFingerprints,
    })).resolves.toBeUndefined();
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'validation_create', validationCloneOrdinal: 2,
      providerValidationId: null, providerValidationActionId: null,
    });
    await expect(db.executor.selectFrom('golden_snapshot_cleanup').select('provider_resource_id')
      .where('build_id', '=', enqueued.build.buildId)
      .where('resource_type', '=', 'validation_server').executeTakeFirst()).resolves.toEqual({
      provider_resource_id: 102,
    });
  });

  it('requeues a definitive builder capacity rejection without entering ambiguous recovery', async () => {
    const createServer = vi.fn()
      .mockRejectedValueOnce(new DefinitiveProviderRejectionError(
        503, 'quota_exceeded', 'Provisioning capacity unavailable',
      ))
      .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} });
    const { enqueued, service } = await setup({ createServer });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toBeInstanceOf(Error);
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'requested', status: 'queued', attempts: 1, pendingOperation: null,
    });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'candidate',
    });

    await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:02:00.000Z', '2026-07-03T00:12:00.000Z', 5,
    );
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('builder_boot');
    expect(createServer).toHaveBeenCalledTimes(2);
  });

  it('requeues a definitive validation capacity rejection from the same validated image', async () => {
    const createServer = vi.fn()
      .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} })
      .mockRejectedValueOnce(new DefinitiveProviderRejectionError(
        503, 'quota_exceeded', 'Provisioning capacity unavailable',
      ))
      .mockResolvedValueOnce({ id: 102, status: 'running', createActionId: 202, labels: {} });
    const { enqueued, service } = await setup({ createServer });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toBeInstanceOf(Error);
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'validation_create', status: 'queued', attempts: 1, pendingOperation: null,
    });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'validating', providerImageId: 301,
    });

    await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:02:00.000Z', '2026-07-03T00:12:00.000Z', 5,
    );
    await expect(service.runBuildStep(enqueued.build.buildId)).resolves.toBe('validation_boot');
    expect(createServer).toHaveBeenCalledTimes(3);
  });

  it('fails safely when definitive builder capacity rejection exhausts the retry budget', async () => {
    const { enqueued, service } = await setup({
      createServer: vi.fn().mockRejectedValue(
        new DefinitiveProviderRejectionError(
          503, 'quota_exceeded', 'Provisioning capacity unavailable',
        ),
      ),
    }, undefined, { ...config, maxBuildAttempts: 1 });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toBeInstanceOf(Error);
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'failed', status: 'failed', pendingOperation: null,
      lastErrorCode: 'provider_capacity_exhausted',
    });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'provider_capacity_exhausted',
    });
  });

  it('quarantines a definitive validation clone rejection instead of probing for an orphan', async () => {
    const createServer = vi.fn()
      .mockResolvedValueOnce({ id: 101, status: 'running', createActionId: 201, labels: {} })
      .mockRejectedValueOnce(new DefinitiveProviderRejectionError(
        500, 'snapshot_clone_rejected', 'Provisioning provider unavailable',
      ));
    const { enqueued, service } = await setup({ createServer });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await service.runBuildStep(enqueued.build.buildId);

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toBeInstanceOf(Error);
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'failed', status: 'failed', pendingOperation: null,
      lastErrorCode: 'validation_create_rejected',
    });
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'validation_create_rejected',
    });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10))
      .resolves.toContainEqual(expect.objectContaining({
        resourceType: 'snapshot_image', providerResourceId: 301,
      }));
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

  it('quarantines stale cleanup after its provider image is adopted by an active snapshot', async () => {
    const image = {
      id: 301, status: 'available' as const, type: 'snapshot' as const,
      architecture: 'x86' as const, diskGb: 40, deleteProtected: false,
      labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
      },
    };
    const { enqueued, service, hetzner } = await setup({
      getImage: vi.fn().mockResolvedValue(image),
      deleteImage: vi.fn().mockResolvedValue(undefined),
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'validating', provider_image_id: image.id, provider_image_status: 'available',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    const cleanupId = '60000000-0000-4000-8000-000000000061';
    await db.executor.insertInto('golden_snapshot_cleanup').values({
      cleanup_id: cleanupId, snapshot_id: enqueued.snapshot.snapshotId,
      build_id: enqueued.build.buildId, resource_type: 'snapshot_image',
      provider_resource_id: image.id,
      provenance_key: `late-image:${enqueued.build.buildId}:${image.id}`,
      reason: 'late_provider_image', status: 'queued', attempts: 0,
      next_attempt_at: '2026-07-03T00:01:00.000Z', lease_expires_at: null,
      last_error_code: null, created_at: '2026-07-03T00:01:00.000Z', completed_at: null,
    }).execute();

    await expect(service.runCleanupStep(cleanupId)).resolves.toBe('quarantined');
    expect(hetzner.deleteImage).not.toHaveBeenCalled();
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'validating', providerImageId: image.id,
    });
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

  it('continues bounded exact-label image cleanup discovery after snapshot quarantine', async () => {
    let currentNow = '2026-07-03T00:01:00.000Z';
    const image = {
      id: 909, status: 'available' as const, type: 'snapshot' as const,
      architecture: 'x86' as const, diskGb: 40, deleteProtected: false,
      labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
        'matrix.role': 'builder',
      },
    };
    const listImagesByLabel = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([image]);
    const { enqueued, service } = await setup({
      createSnapshot: vi.fn().mockRejectedValueOnce(new Error('synthetic timeout')),
      listImagesByLabel,
    }, () => currentNow);
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    currentNow = '2026-07-03T00:31:01.000Z';
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('recovery window');
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({
      status: 'failed', pendingOperation: `snapshot:${enqueued.snapshot.snapshotId}`,
    });

    currentNow = '2026-07-03T00:32:00.000Z';
    await expect(service.runOrphanReconciliationStep(enqueued.build.buildId)).resolves.toBe('queued');
    expect(await listPendingGoldenSnapshotCleanup(db, currentNow, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: image.id }),
    ]));
    expect(await getGoldenSnapshotBuild(db, enqueued.build.buildId)).toMatchObject({ pendingOperation: null });
  });

  it('quarantines an image already deleting in the snapshot create response', async () => {
    const { enqueued, service } = await setup({
      createSnapshot: vi.fn().mockResolvedValue({
        image: { id: 301, status: 'deleting', type: 'snapshot', architecture: 'x86', diskGb: 40, labels: {}, deleteProtected: false },
        action: { id: 401, status: 'success', command: 'create_image' },
      }),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('image validation failed');
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'image_unavailable',
    });
  });

  it('quarantines an exact labeled image already deleting during ambiguous-create recovery', async () => {
    const deletingImage = {
      id: 301, status: 'deleting' as const, type: 'snapshot' as const,
      architecture: 'x86' as const, diskGb: 40, deleteProtected: false,
      labels: {
        'matrix.snapshot-build': '20000000-0000-4000-8000-000000000001',
        'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001',
        'matrix.role': 'builder',
      },
    };
    const { enqueued, service } = await setup({
      createSnapshot: vi.fn().mockRejectedValueOnce(new Error('synthetic timeout')),
      listImagesByLabel: vi.fn().mockResolvedValue([deletingImage]),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });

    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('provider operation');
    await expect(service.runBuildStep(enqueued.build.buildId)).rejects.toThrow('image validation failed');
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', failureCode: 'image_unavailable',
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
    const { enqueued, service, hetzner } = await setup({
      getAction: vi.fn(async (actionId: number) => actionId === 201
        ? { id: 201, status: 'success' as const, command: 'create_server' }
        : null),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_wait');
    expect(await service.runBuildStep(enqueued.build.buildId)).toBe('snapshot_wait');
    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
  });

  it('requeues snapshot creation after provider quota pressure', async () => {
    const { enqueued, service } = await setup({
      createSnapshot: vi.fn().mockRejectedValue(
        new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable'),
      ),
    });
    await service.runBuildStep(enqueued.build.buildId);
    await service.consumeCallback(enqueued.build.buildId, 'phase-token-long-enough', {
      eventId: randomUUID(),
      phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64), ...builderFingerprints,
    });
    await expect(service.runBuildStep(enqueued.build.buildId))
      .rejects.toMatchObject({ code: 'snapshot_quota_exceeded' });
    await expect(getGoldenSnapshotBuild(db, enqueued.build.buildId)).resolves.toMatchObject({
      phase: 'snapshot_create', pendingOperation: null,
    });
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
