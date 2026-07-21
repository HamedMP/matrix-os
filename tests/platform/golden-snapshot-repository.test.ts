import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promoteHostBundleChannel, upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  advanceGoldenSnapshot,
  claimGoldenSnapshotBuild,
  claimGoldenSnapshotBuildBatch,
  createGoldenSnapshotCreateIntent,
  enqueueGoldenSnapshotBuild,
  getGoldenSnapshot,
  getGoldenSnapshotCreateIntent,
  listCallbackWaitGoldenSnapshotBuildIds,
  listClaimableGoldenSnapshotBuildIds,
  listPendingGoldenSnapshotCleanup,
  listRunnableGoldenSnapshotBuildIds,
  markGoldenSnapshotReady,
  recordGoldenSnapshotProviderImage,
  reconcileExpiredGoldenSnapshotLeases,
  reconcileRevokedGoldenSnapshotBaseGeneration,
  releaseGoldenSnapshotLease,
  retryGoldenSnapshotCleanup,
  retireGoldenSnapshot,
  revokeGoldenSnapshot,
  revokeGoldenSnapshotBaseGeneration,
  selectAndLeaseGoldenSnapshot,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import type { GoldenSnapshotCompatibility } from '../../packages/platform/src/golden-snapshot-schema.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const compatibility: GoldenSnapshotCompatibility = {
  provider: 'hetzner',
  architecture: 'x86',
  region: 'eu-central',
  baseImage: 'ubuntu-24.04',
  baseGeneration: 'ubuntu-24.04-v1',
  bootMode: 'bios',
  activationAbi: 'host-v1',
  minimumDiskGb: 40,
};

async function advanceToValidating(
  db: PlatformDB,
  snapshotId: string,
  buildId: string,
): Promise<void> {
  const claimed = await claimGoldenSnapshotBuild(
    db, buildId, '2026-07-03T00:00:30.000Z', '2026-07-03T00:10:00.000Z', 5,
  );
  expect(claimed?.leaseExpiresAt).toBe('2026-07-03T00:10:00.000Z');
  const fence = claimed!.leaseExpiresAt!;
  await advanceGoldenSnapshot(db, snapshotId, buildId, fence, 'candidate', 'building', '2026-07-03T00:01:00.000Z');
  await advanceGoldenSnapshot(db, snapshotId, buildId, fence, 'building', 'sanitizing', '2026-07-03T00:02:00.000Z');
  await advanceGoldenSnapshot(db, snapshotId, buildId, fence, 'sanitizing', 'validating', '2026-07-03T00:03:00.000Z');
}

describe('golden snapshot repository', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await upsertHostBundleRelease(db, {
      version: 'v1',
      gitCommit: '1111111',
      buildTime: '2026-07-01T00:00:00.000Z',
      bundleKey: 'system-bundles/v1/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v1/matrix-host-bundle.tar.gz.sha256',
      sha256: '1'.repeat(64),
      size: 100,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await upsertHostBundleRelease(db, {
      version: 'v2',
      gitCommit: '2222222',
      buildTime: '2026-07-02T00:00:00.000Z',
      bundleKey: 'system-bundles/v2/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2/matrix-host-bundle.tar.gz.sha256',
      sha256: '2'.repeat(64),
      size: 100,
      createdAt: '2026-07-02T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('migrates every authoritative lifecycle table', async () => {
    const rows = await db.executor
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_schema', '=', 'public')
      .where('table_name', 'like', 'golden_snapshot%')
      .orderBy('table_name')
      .execute();
    expect(rows.map((row) => row.table_name)).toEqual([
      'golden_snapshot_audit_events',
      'golden_snapshot_builds',
      'golden_snapshot_callback_receipts',
      'golden_snapshot_cleanup',
      'golden_snapshot_create_intents',
      'golden_snapshot_leases',
      'golden_snapshot_revoked_base_generations',
      'golden_snapshots',
    ]);
  });

  it('persists immutable audit evidence in the lifecycle transaction', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000047',
      buildId: '20000000-0000-4000-8000-000000000047',
      now: '2026-07-03T00:00:00.000Z',
    });

    await expect(db.executor.selectFrom('golden_snapshot_audit_events')
      .select(['snapshot_id', 'build_id', 'event_type', 'actor_type', 'to_state'])
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute())
      .resolves.toEqual([{
        snapshot_id: enqueued.snapshot.snapshotId,
        build_id: enqueued.build.buildId,
        event_type: 'build_enqueued',
        actor_type: 'release',
        to_state: 'candidate',
      }]);
  });

  it('persists builder identity fingerprints outside the reusable image', async () => {
    const columns = await db.executor
      .selectFrom('information_schema.columns')
      .select('column_name')
      .where('table_schema', '=', 'public')
      .where('table_name', '=', 'golden_snapshot_builds')
      .where('column_name', 'in', [
        'builder_machine_id_sha256', 'builder_ssh_host_key_sha256', 'provider_builder_action_id',
        'validation_clone_ordinal', 'first_validation_machine_id_sha256',
        'first_validation_ssh_host_key_sha256',
      ])
      .orderBy('column_name')
      .execute();
    expect(columns.map((row) => row.column_name)).toEqual([
      'builder_machine_id_sha256',
      'builder_ssh_host_key_sha256',
      'first_validation_machine_id_sha256',
      'first_validation_ssh_host_key_sha256',
      'provider_builder_action_id',
      'validation_clone_ordinal',
    ]);

    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1',
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000009',
      buildId: '20000000-0000-4000-8000-000000000009',
      now: '2026-07-03T00:00:00.000Z',
    });
    expect(enqueued.build).toMatchObject({
      builderMachineIdSha256: null,
      builderSshHostKeySha256: null,
      providerBuilderActionId: null,
      validationCloneOrdinal: 1,
      firstValidationMachineIdSha256: null,
      firstValidationSshHostKeySha256: null,
    });
  });

  it('normalizes an uppercase registered release digest before snapshot persistence', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v-uppercase-sha', gitCommit: 'c'.repeat(40), gitRef: 'main',
      buildTime: '2026-07-03T00:00:00.000Z', bundleKey: 'bundles/v-uppercase-sha.tar.gz',
      checksumKey: 'bundles/v-uppercase-sha.tar.gz.sha256', sha256: 'A'.repeat(64),
      size: 100, createdAt: '2026-07-03T00:00:00.000Z',
    });

    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v-uppercase-sha', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000039',
      buildId: '20000000-0000-4000-8000-000000000039', now: '2026-07-03T00:00:00.000Z',
    });

    expect(enqueued.snapshot.bundleSha256).toBe('a'.repeat(64));
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', provider_image_id: 939, provider_image_status: 'available',
      image_disk_gb: 40, image_architecture: 'x86', ready_at: '2026-07-03T00:01:00.000Z',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await expect(selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v-uppercase-sha', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000039', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000039',
      now: '2026-07-03T00:02:00.000Z', expiresAt: '2026-07-03T00:12:00.000Z',
    })).resolves.toMatchObject({ snapshot: { snapshotId: enqueued.snapshot.snapshotId } });
  });

  it('claims no more than the durable concurrent build capacity', async () => {
    const first = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000031',
      buildId: '20000000-0000-4000-8000-000000000031', now: '2026-07-03T00:00:00.000Z',
    });
    await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000032',
      buildId: '20000000-0000-4000-8000-000000000032', now: '2026-07-03T00:00:01.000Z',
    });

    await expect(claimGoldenSnapshotBuildBatch(
      db, '2026-07-03T00:00:02.000Z', '2026-07-03T00:10:02.000Z', 5, 10, 1,
    )).resolves.toEqual([
      expect.objectContaining({ buildId: first.build.buildId, status: 'running' }),
    ]);
    await expect(claimGoldenSnapshotBuildBatch(
      db, '2026-07-03T00:00:03.000Z', '2026-07-03T00:10:03.000Z', 5, 10, 1,
    )).resolves.toEqual([]);
  });

  it('counts callback-wait infrastructure against the durable concurrency cap', async () => {
    const waiting = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000041',
      buildId: '20000000-0000-4000-8000-000000000041', now: '2026-07-03T00:00:00.000Z',
    });
    await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000042',
      buildId: '20000000-0000-4000-8000-000000000042', now: '2026-07-03T00:00:01.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'builder_boot', attempts: 1,
      lease_expires_at: '2026-07-03T00:01:00.000Z',
      callback_expires_at: '2026-07-03T00:30:00.000Z', provider_builder_id: 941,
    }).where('build_id', '=', waiting.build.buildId).execute();

    await expect(claimGoldenSnapshotBuildBatch(
      db, '2026-07-03T00:02:00.000Z', '2026-07-03T00:07:00.000Z', 5, 10, 1,
    )).resolves.toEqual([]);
  });

  it('requeues only terminal cleanup on the same durable exact-resource row', async () => {
    const cleanupId = '50000000-0000-4000-8000-000000000031';
    await db.executor.insertInto('golden_snapshot_cleanup').values({
      cleanup_id: cleanupId, snapshot_id: null, build_id: null,
      resource_type: 'builder_server', provider_resource_id: 931,
      provenance_key: 'builder:931', reason: 'ambiguous_delete', status: 'quarantined',
      attempts: 5, next_attempt_at: '2026-07-03T00:10:00.000Z',
      lease_expires_at: '2026-07-03T00:11:00.000Z', last_error_code: 'provenance_mismatch',
      created_at: '2026-07-03T00:00:00.000Z', completed_at: null,
    }).execute();

    await expect(retryGoldenSnapshotCleanup(
      db, cleanupId, '2026-07-03T00:12:00.000Z',
    )).resolves.toBe(true);
    await expect(db.executor.selectFrom('golden_snapshot_cleanup').selectAll()
      .where('cleanup_id', '=', cleanupId).executeTakeFirstOrThrow()).resolves.toMatchObject({
      status: 'queued', attempts: 0, next_attempt_at: '2026-07-03T00:12:00.000Z',
      lease_expires_at: null, last_error_code: null, provider_resource_id: 931,
    });
    await expect(retryGoldenSnapshotCleanup(
      db, cleanupId, '2026-07-03T00:13:00.000Z',
    )).resolves.toBe(false);
  });

  it('persists quarantined cleanup when provider deletion remains ambiguous', async () => {
    await db.executor.insertInto('golden_snapshot_cleanup').values({
      cleanup_id: '50000000-0000-4000-8000-000000000001',
      snapshot_id: null,
      build_id: null,
      resource_type: 'builder_server',
      provider_resource_id: 501,
      provenance_key: 'build:ambiguous:builder_server',
      reason: 'ambiguous_delete',
      status: 'quarantined',
      attempts: 5,
      next_attempt_at: '2026-07-03T00:00:00.000Z',
      lease_expires_at: null,
      last_error_code: 'ambiguous_delete',
      created_at: '2026-07-03T00:00:00.000Z',
      completed_at: null,
    }).execute();

    await expect(db.executor.selectFrom('golden_snapshot_cleanup')
      .select('status').where('cleanup_id', '=', '50000000-0000-4000-8000-000000000001')
      .executeTakeFirstOrThrow()).resolves.toEqual({ status: 'quarantined' });
  });

  it('enqueues idempotently by immutable bundle digest and compatibility', async () => {
    const input = {
      bundleVersion: 'v1',
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000001',
      buildId: '20000000-0000-4000-8000-000000000001',
      now: '2026-07-03T00:00:00.000Z',
    };
    const [first, second] = await Promise.all([
      enqueueGoldenSnapshotBuild(db, input),
      enqueueGoldenSnapshotBuild(db, {
        ...input,
        snapshotId: '10000000-0000-4000-8000-000000000002',
        buildId: '20000000-0000-4000-8000-000000000002',
      }),
    ]);
    expect(first.snapshot.snapshotId).toBe(second.snapshot.snapshotId);
    expect(first.build.buildId).toBe(second.build.buildId);
    expect([first.reused, second.reused].filter(Boolean)).toHaveLength(1);

    const testCandidate = await enqueueGoldenSnapshotBuild(db, {
      ...input,
      testMode: true,
      snapshotId: '10000000-0000-4000-8000-000000000013',
      buildId: '20000000-0000-4000-8000-000000000013',
    });
    expect(testCandidate.snapshot).toMatchObject({ testMode: true });
    expect(testCandidate.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
  });

  it('rejects terminal immutable reuse until the explicit retry transaction resets it', async () => {
    const first = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000035',
      buildId: '20000000-0000-4000-8000-000000000035', now: '2026-07-03T00:00:00.000Z',
    });
    await db.transaction(async (trx) => {
      await trx.executor.updateTable('golden_snapshots').set({
        state: 'failed', failure_code: 'retry_budget_exhausted', updated_at: '2026-07-03T00:01:00.000Z',
      }).where('snapshot_id', '=', first.snapshot.snapshotId).execute();
      await trx.executor.updateTable('golden_snapshot_builds').set({
        phase: 'failed', status: 'failed', last_error_code: 'retry_budget_exhausted',
        completed_at: '2026-07-03T00:01:00.000Z', updated_at: '2026-07-03T00:01:00.000Z',
      }).where('build_id', '=', first.build.buildId).execute();
    });

    await expect(enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000036',
      buildId: '20000000-0000-4000-8000-000000000036', now: '2026-07-03T00:02:00.000Z',
    })).rejects.toThrow('explicit retry');
  });

  it('keeps the idempotent provenance guard meaningful after conflict lookup', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-repository.ts', 'utf8');
    expect(source).not.toContain('snapshot.compatibilityKey !== key');
  });

  it('rejects a rewrite of immutable release build ordering provenance', async () => {
    await expect(upsertHostBundleRelease(db, {
      version: 'v1', gitCommit: '1111111', buildTime: '2026-07-09T00:00:00.000Z',
      bundleKey: 'system-bundles/v1/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v1/matrix-host-bundle.tar.gz.sha256',
      sha256: '1'.repeat(64), size: 100, createdAt: '2026-07-09T00:00:00.000Z',
    })).rejects.toThrow('different artifact fields');
  });

  it('rejects malformed release build ordering provenance before snapshot SQL casts', async () => {
    await expect(upsertHostBundleRelease(db, {
      version: 'invalid-build-time', gitCommit: '3333333', buildTime: 'not-a-timestamp',
      bundleKey: 'system-bundles/invalid-build-time/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/invalid-build-time/matrix-host-bundle.tar.gz.sha256',
      sha256: '3'.repeat(64), size: 100, createdAt: '2026-07-09T00:00:00.000Z',
    })).rejects.toThrow();
  });

  it('accepts equivalent legacy release timestamp spellings', async () => {
    await db.executor.updateTable('host_bundle_releases')
      .set({ build_time: '2026-07-01T00:00:00Z' })
      .where('version', '=', 'v1')
      .execute();

    await expect(upsertHostBundleRelease(db, {
      version: 'v1', gitCommit: '1111111', buildTime: '2026-07-01T00:00:00.000Z',
      bundleKey: 'system-bundles/v1/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v1/matrix-host-bundle.tar.gz.sha256',
      sha256: '1'.repeat(64), size: 100, createdAt: '2026-07-01T00:00:00.000Z',
    })).resolves.toMatchObject({ version: 'v1' });
  });

  it('claims an expired-or-queued build with one conditional write', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1',
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000003',
      buildId: '20000000-0000-4000-8000-000000000003',
      now: '2026-07-03T00:00:00.000Z',
    });
    await expect(claimGoldenSnapshotBuild(
      db,
      enqueued.build.buildId,
      '2026-07-03T01:00:00+02:00',
      '2026-07-03T01:05:00+02:00',
      5,
    )).resolves.toBeUndefined();
    const first = await claimGoldenSnapshotBuild(
      db,
      enqueued.build.buildId,
      '2026-07-03T00:01:00.000Z',
      '2026-07-03T00:06:00.000Z',
      5,
    );
    const second = await claimGoldenSnapshotBuild(
      db,
      enqueued.build.buildId,
      '2026-07-03T00:02:00.000Z',
      '2026-07-03T00:07:00.000Z',
      5,
    );
    expect(first).toMatchObject({ status: 'running', attempts: 1 });
    expect(second).toBeUndefined();
  });

  it('does not claim a build after its snapshot is revoked', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000023',
      buildId: '20000000-0000-4000-8000-000000000023',
      now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'validation_boot', provider_builder_id: 823,
      provider_validation_id: 824, lease_expires_at: '2026-07-03T00:10:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await db.executor.updateTable('golden_snapshots').set({
      state: 'validating', provider_image_id: 923,
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await revokeGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'operator_revoked', '2026-07-03T00:00:30.000Z',
    );

    await expect(claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:01:00.000Z', '2026-07-03T00:06:00.000Z', 5,
    )).resolves.toBeUndefined();
    expect(await db.executor.selectFrom('golden_snapshot_builds')
      .select(['status', 'phase', 'last_error_code'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow()).toEqual({
      status: 'failed', phase: 'failed', last_error_code: 'operator_revoked',
    });
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:01:00.000Z', 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'builder_server', providerResourceId: 823 }),
        expect.objectContaining({ resourceType: 'validation_server', providerResourceId: 824 }),
        expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 923 }),
      ]),
    );
  });

  it('does not reclaim a callback-wait build before its callback deadline', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000048',
      buildId: '20000000-0000-4000-8000-000000000048',
      now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'builder_boot', status: 'running', attempts: 5,
      lease_expires_at: '2026-07-03T00:05:00.000Z',
      callback_expires_at: '2026-07-03T00:30:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();

    await expect(claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:10:00.000Z', '2026-07-03T00:15:00.000Z', 5,
    )).resolves.toBeUndefined();
    await expect(db.executor.selectFrom('golden_snapshot_builds').select(['status', 'attempts'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow())
      .resolves.toEqual({ status: 'running', attempts: 5 });
  });

  it('rejects expired and overlong provisioning lease windows', async () => {
    const base = {
      targetBundleVersion: 'v1', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000048', purpose: 'provision' as const,
      leaseId: '40000000-0000-4000-8000-000000000048',
      now: '2026-07-03T00:00:00.000Z',
    };
    await expect(selectAndLeaseGoldenSnapshot(db, {
      ...base, expiresAt: base.now,
    })).rejects.toThrow('lease expiration');
    await expect(selectAndLeaseGoldenSnapshot(db, {
      ...base, expiresAt: '2026-07-03T00:10:00.001Z', maxLeaseMs: 10 * 60 * 1000,
    })).rejects.toThrow('maximum TTL');
  });

  it('rejects build claims whose lease is not strictly in the future', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000043',
      buildId: '20000000-0000-4000-8000-000000000043',
      now: '2026-07-03T00:00:00.000Z',
    });

    await expect(claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:01:00.000Z', '2026-07-03T00:01:00.000Z', 5,
    )).rejects.toThrow('lease expiration');
  });

  it('enforces capacity when a known build is claimed directly', async () => {
    const first = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000044',
      buildId: '20000000-0000-4000-8000-000000000044',
      now: '2026-07-03T00:00:00.000Z',
    });
    const second = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000045',
      buildId: '20000000-0000-4000-8000-000000000045',
      testMode: true,
      now: '2026-07-03T00:00:00.000Z',
    });

    await expect(claimGoldenSnapshotBuild(
      db, first.build.buildId, '2026-07-03T00:01:00.000Z', '2026-07-03T00:06:00.000Z', 5, 1,
    )).resolves.toMatchObject({ status: 'running' });
    await expect(claimGoldenSnapshotBuild(
      db, second.build.buildId, '2026-07-03T00:01:01.000Z', '2026-07-03T00:06:01.000Z', 5, 1,
    )).resolves.toBeUndefined();
  });

  it('counts cleanup-pending builder infrastructure against claim capacity', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000046',
      buildId: '20000000-0000-4000-8000-000000000046',
      now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.insertInto('golden_snapshot_cleanup').values({
      cleanup_id: '50000000-0000-4000-8000-000000000046',
      snapshot_id: null,
      build_id: null,
      resource_type: 'builder_server',
      provider_resource_id: 846,
      provenance_key: 'build:orphan:builder_server',
      reason: 'ambiguous_create',
      status: 'queued',
      attempts: 0,
      next_attempt_at: '2026-07-03T00:00:00.000Z',
      lease_expires_at: null,
      last_error_code: null,
      created_at: '2026-07-03T00:00:00.000Z',
      completed_at: null,
    }).execute();

    await expect(claimGoldenSnapshotBuildBatch(
      db, '2026-07-03T00:01:00.000Z', '2026-07-03T00:06:00.000Z', 5, 10, 1,
    )).resolves.toEqual([]);
    await expect(db.executor.selectFrom('golden_snapshot_builds')
      .select(['status', 'attempts']).where('build_id', '=', enqueued.build.buildId)
      .executeTakeFirstOrThrow()).resolves.toEqual({ status: 'queued', attempts: 0 });
  });

  it('uses the configured retry budget when listing claimable builds', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000020',
      buildId: '20000000-0000-4000-8000-000000000020',
      now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      attempts: 3, status: 'running', lease_expires_at: '2026-07-03T00:00:30.000Z',
    })
      .where('build_id', '=', enqueued.build.buildId).execute();

    await expect(listClaimableGoldenSnapshotBuildIds(
      db, '2026-07-03T00:01:00.000Z', 10, 3,
    )).resolves.toEqual([enqueued.build.buildId]);
    await expect(listClaimableGoldenSnapshotBuildIds(
      db, '2026-07-03T00:01:00.000Z', 10, 4,
    )).resolves.toEqual([enqueued.build.buildId]);
  });

  it('does not spend retry attempts while waiting for a bounded callback', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000026',
      buildId: '20000000-0000-4000-8000-000000000026',
      now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'builder_boot', status: 'running', attempts: 5,
      lease_expires_at: '2026-07-03T00:05:00.000Z',
      callback_expires_at: '2026-07-03T00:30:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();

    await expect(listClaimableGoldenSnapshotBuildIds(
      db, '2026-07-03T00:10:00.000Z', 10, 5,
    )).resolves.toEqual([]);
    await expect(claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:10:00.000Z', '2026-07-03T00:15:00.000Z', 5,
    )).resolves.toBeUndefined();
    await expect(listRunnableGoldenSnapshotBuildIds(
      db, '2026-07-03T00:31:00.000Z', 10,
    )).resolves.toEqual([]);
    await expect(listCallbackWaitGoldenSnapshotBuildIds(db, 10))
      .resolves.toEqual([enqueued.build.buildId]);
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({ state: 'candidate' });
    await expect(db.executor.selectFrom('golden_snapshot_builds').select(['status', 'attempts'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow())
      .resolves.toEqual({ status: 'running', attempts: 5 });
  });

  it('rotates runnable polling builds when the dispatch batch is smaller than capacity', async () => {
    const first = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000054',
      buildId: '20000000-0000-4000-8000-000000000054', now: '2026-07-03T00:00:00.000Z',
    });
    const second = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000055',
      buildId: '20000000-0000-4000-8000-000000000055', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'builder_create', status: 'running', lease_expires_at: '2026-07-03T00:20:00.000Z',
      updated_at: '2026-07-03T00:00:00.000Z',
    }).where('build_id', 'in', [first.build.buildId, second.build.buildId]).execute();

    await expect(listRunnableGoldenSnapshotBuildIds(db, '2026-07-03T00:01:00.000Z', 1))
      .resolves.toEqual([first.build.buildId]);
    await expect(listRunnableGoldenSnapshotBuildIds(db, '2026-07-03T00:02:00.000Z', 1))
      .resolves.toEqual([second.build.buildId]);
  });

  it('finalizes an expired build whose retry budget is exhausted', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000008',
      buildId: '20000000-0000-4000-8000-000000000008',
      now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'snapshot_create', attempts: 1,
      lease_expires_at: '2026-07-03T00:01:00.000Z', provider_builder_id: 808,
    }).where('build_id', '=', enqueued.build.buildId).execute();

    await expect(claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:02:00.000Z', '2026-07-03T00:07:00.000Z', 1,
    )).resolves.toBeUndefined();
    expect(await db.executor.selectFrom('golden_snapshot_builds').select(['status', 'phase', 'last_error_code'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirst()).toEqual({
      status: 'failed', phase: 'failed', last_error_code: 'retry_budget_exhausted',
    });
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'failed' });
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10)).toEqual([
      expect.objectContaining({ resourceType: 'builder_server', providerResourceId: 808 }),
    ]);
  });

  it('finalizes exhausted expired builds before the bounded batch claims new work', async () => {
    const exhausted = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000040',
      buildId: '20000000-0000-4000-8000-000000000040', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'builder_boot', attempts: 2,
      lease_expires_at: '2026-07-03T00:01:00.000Z', provider_builder_id: 840,
    }).where('build_id', '=', exhausted.build.buildId).execute();

    await expect(claimGoldenSnapshotBuildBatch(
      db, '2026-07-03T00:02:00.000Z', '2026-07-03T00:07:00.000Z', 2, 10, 2,
    )).resolves.toEqual([]);
    await expect(db.executor.selectFrom('golden_snapshot_builds')
      .select(['status', 'phase', 'last_error_code']).where('build_id', '=', exhausted.build.buildId)
      .executeTakeFirstOrThrow()).resolves.toEqual({
      status: 'failed', phase: 'failed', last_error_code: 'retry_budget_exhausted',
    });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10))
      .resolves.toContainEqual(expect.objectContaining({
        resourceType: 'builder_server', providerResourceId: 840,
      }));
  });

  it('rejects generic transitions that bypass readiness or retirement invariants', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000007',
      buildId: '20000000-0000-4000-8000-000000000007',
      now: '2026-07-03T00:00:00.000Z',
    });
    await advanceToValidating(db, enqueued.snapshot.snapshotId, enqueued.build.buildId);
    await expect(advanceGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, enqueued.build.buildId, '2026-07-03T00:10:00.000Z',
      'validating', 'ready', '2026-07-03T00:04:00.000Z',
    )).rejects.toThrow('specialized lifecycle transition');
  });

  it('fences generic lifecycle advancement by the active build lease', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000027',
      buildId: '20000000-0000-4000-8000-000000000027',
      now: '2026-07-03T00:00:00.000Z',
    });
    const firstClaim = await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:00:30.000Z', '2026-07-03T00:01:00.000Z', 5,
    );
    expect(await advanceGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, enqueued.build.buildId, firstClaim!.leaseExpiresAt!,
      'candidate', 'building', '2026-07-03T00:00:45.000Z',
    )).toBe(true);
    await expect(db.executor.selectFrom('golden_snapshot_builds').select('phase')
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow())
      .resolves.toEqual({ phase: 'builder_create' });
    const secondClaim = await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:02:00.000Z', '2026-07-03T00:07:00.000Z', 5,
    );
    expect(secondClaim?.leaseExpiresAt).toBe('2026-07-03T00:07:00.000Z');
    expect(await advanceGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, enqueued.build.buildId, firstClaim!.leaseExpiresAt!,
      'building', 'sanitizing', '2026-07-03T00:02:01.000Z',
    )).toBe(false);
    expect(await advanceGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, enqueued.build.buildId, secondClaim!.leaseExpiresAt!,
      'building', 'sanitizing', '2026-07-03T00:02:02.000Z',
    )).toBe(true);
    await expect(db.executor.selectFrom('golden_snapshot_builds').select('phase')
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow())
      .resolves.toEqual({ phase: 'sanitizing' });
  });

  it('rejects lifecycle advancement after the worker lease expires', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000028',
      buildId: '20000000-0000-4000-8000-000000000028',
      now: '2026-07-03T00:00:00.000Z',
    });
    const claim = await claimGoldenSnapshotBuild(
      db, enqueued.build.buildId, '2026-07-03T00:00:10.000Z', '2026-07-03T00:01:00.000Z', 5,
    );

    expect(await advanceGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, enqueued.build.buildId, claim!.leaseExpiresAt!,
      'candidate', 'building', '2026-07-03T00:01:01.000Z',
    )).toBe(false);
  });

  it('makes validation evidence and readiness atomic before selection', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1',
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000004',
      buildId: '20000000-0000-4000-8000-000000000004',
      now: '2026-07-03T00:00:00.000Z',
    });
    await advanceToValidating(db, enqueued.snapshot.snapshotId, enqueued.build.buildId);
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 42,
      providerImageStatus: 'available',
      imageDiskGb: 40,
      imageArchitecture: 'x86',
      now: '2026-07-03T00:04:00.000Z',
    });

    await expect(markGoldenSnapshotReady(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, {
      validationSummary: {
        exactBundle: true, healthy: true, freshActivation: true, uniqueMachineId: true,
        uniqueSshHostKey: true, forbiddenStateAbsent: true,
      },
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      now: '2026-07-03T00:05:00.000Z',
    })).rejects.toThrow('current validation lease');

    expect(await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1',
      compatibility,
      serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000004',
      purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000004',
      now: '2026-07-03T00:04:30.000Z',
      expiresAt: '2026-07-03T00:14:30.000Z',
    })).toBeUndefined();

    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'validation_boot', status: 'running', lease_expires_at: '2026-07-03T00:10:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await markGoldenSnapshotReady(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, {
      validationSummary: {
        exactBundle: true,
        healthy: true,
        freshActivation: true,
        uniqueMachineId: true,
        uniqueSshHostKey: true,
        forbiddenStateAbsent: true,
      },
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      now: '2026-07-03T00:05:00.000Z',
    });
    const selected = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1',
      compatibility,
      serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000004',
      purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000004',
      now: '2026-07-03T00:05:30.000Z',
      expiresAt: '2026-07-03T00:15:30.000Z',
    });
    expect(selected?.snapshot).toMatchObject({ providerImageId: 42, state: 'ready' });
    expect(selected?.lease.snapshotId).toBe(enqueued.snapshot.snapshotId);
    const reused = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000004', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000006',
      now: '2026-07-03T00:06:00.000Z', expiresAt: '2026-07-03T00:16:00.000Z',
    });
    expect(reused).toMatchObject({
      lease: {
        leaseId: selected?.lease.leaseId,
        createdAt: '2026-07-03T00:05:30.000Z',
      },
    });

    expect(await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1', compatibility, serverDiskGb: 20,
      machineId: '30000000-0000-4000-8000-000000000004', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000009',
      now: '2026-07-03T00:06:30.000Z', expiresAt: '2026-07-03T00:16:30.000Z',
    })).toBeUndefined();

    const renewed = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000004', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000007',
      now: '2026-07-03T00:16:01.000Z', expiresAt: '2026-07-03T00:26:01.000Z',
    });
    expect(renewed).toMatchObject({
      lease: {
        leaseId: selected?.lease.leaseId,
        createdAt: '2026-07-03T00:05:30.000Z',
        expiresAt: '2026-07-03T00:26:01.000Z',
      },
    });

    await upsertHostBundleRelease(db, {
      version: 'v2', gitCommit: '2222222', buildTime: '2026-07-02T00:00:00.000Z',
      bundleKey: 'system-bundles/v2/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2/matrix-host-bundle.tar.gz.sha256',
      sha256: '2'.repeat(64), size: 100, createdAt: '2026-07-02T00:00:00.000Z',
    });
    const retargeted = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v2', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000004', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000008',
      now: '2026-07-03T00:27:00.000Z', expiresAt: '2026-07-03T00:37:00.000Z',
    });
    expect(retargeted).toMatchObject({
      snapshot: { snapshotId: enqueued.snapshot.snapshotId },
      lease: { leaseId: '40000000-0000-4000-8000-000000000008', targetBundleVersion: 'v2' },
    });
    await expect(db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('lease_id', '=', selected!.lease.leaseId).executeTakeFirstOrThrow())
      .resolves.toEqual({ released_at: '2026-07-03T00:27:00.000Z' });
  });

  it('pre-filters bounded reusable candidates by exact or chronologically older provenance', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-repository.ts', 'utf8');
    const start = source.indexOf('export async function selectAndLeaseGoldenSnapshot');
    const end = source.indexOf('export async function releaseGoldenSnapshotLease', start);
    const selection = source.slice(start, end);
    expect(selection).toContain("eb('golden_snapshots.bundle_sha256', '=', targetSha256)");
    expect(selection).toContain("sql.ref('host_bundle_releases.build_time')}::timestamptz <");
    expect(selection).toContain("CASE WHEN ${sql.ref('golden_snapshots.bundle_sha256')}");
  });

  it('preserves the first exact provider image and quarantines a conflicting observation', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000011',
      buildId: '20000000-0000-4000-8000-000000000011', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'validating' })
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'snapshot_wait', provider_builder_id: 41,
      lease_expires_at: '2026-07-03T00:10:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();
    expect(await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 51, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:01:00.000Z',
    })).toBe(true);
    expect(await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 52, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:02:00.000Z',
    })).toBe(false);
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({
      state: 'quarantined', providerImageId: 51,
    });
    await expect(db.executor.selectFrom('golden_snapshot_builds').select(['status', 'phase', 'last_error_code'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow()).resolves.toEqual({
      status: 'failed', phase: 'failed', last_error_code: 'provider_image_identity_conflict',
    });
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:03:00.000Z', 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'builder_server', providerResourceId: 41 }),
        expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 51 }),
        expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 52 }),
      ]),
    );
  });

  it('quarantines conflicting metadata for the current image without queuing that image for deletion', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000052',
      buildId: '20000000-0000-4000-8000-000000000052', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', provider_image_id: 952, provider_image_status: 'available',
      image_architecture: 'x86', image_disk_gb: 40, ready_at: '2026-07-03T00:01:00.000Z',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();

    await expect(recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 952, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'arm', now: '2026-07-03T00:02:00.000Z',
    })).resolves.toBe(false);

    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'quarantined', providerImageId: 952, failureCode: 'provider_image_metadata_conflict',
    });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:03:00.000Z', 10))
      .resolves.not.toContainEqual(expect.objectContaining({
        resourceType: 'snapshot_image', providerResourceId: 952,
      }));
  });

  it('revalidates expired lease workflow state under lock before releasing it', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-repository.ts', 'utf8');
    const start = source.indexOf('async function releaseExpiredGoldenSnapshotLease');
    const end = source.indexOf('export async function reconcileExpiredGoldenSnapshotLeases', start);
    const release = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(release).toContain("selectFrom('provisioning_jobs')");
    expect(release).toContain("selectFrom('user_machines')");
    expect(release).toContain('.forUpdate()');
    expect(release).toContain("['completed', 'failed']");
    expect(release).toContain("['running', 'failed', 'deleted']");
  });

  it('rejects provider-image writes from a superseded worker lease', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000043',
      buildId: '20000000-0000-4000-8000-000000000043', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'validating' })
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'snapshot_wait', attempts: 2,
      lease_expires_at: '2026-07-03T00:20:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();

    await expect(recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 943, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:05:00.000Z',
    })).resolves.toBe(false);
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'validating', providerImageId: null,
    });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:06:00.000Z', 10))
      .resolves.toContainEqual(expect.objectContaining({
        resourceType: 'snapshot_image', providerResourceId: 943,
      }));
  });

  it('never regresses an available provider image to creating', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000031',
      buildId: '20000000-0000-4000-8000-000000000031', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'validating' })
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'snapshot_wait', lease_expires_at: '2026-07-03T00:10:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 531, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:01:00.000Z',
    });
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 531, providerImageStatus: 'creating', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:02:00.000Z',
    });

    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      providerImageId: 531,
      providerImageStatus: 'available',
    });
  });

  it('normalizes Postgres BIGINT image IDs before accepting an idempotent ready observation', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-repository.ts', 'utf8');
    expect(source).toContain('Number(current.provider_image_id) === input.providerImageId');
  });

  it('compares active lease expiry timestamps as instants across offsets', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000024',
      buildId: '20000000-0000-4000-8000-000000000024',
      now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', provider_image_id: 124, provider_image_status: 'available',
      image_disk_gb: 40, image_architecture: 'x86', ready_at: '2026-07-03T00:00:30.000Z',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000024', snapshot_id: enqueued.snapshot.snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000024', purpose: 'provision',
      target_bundle_version: 'v1', created_at: '2026-07-02T22:50:00.000Z',
      expires_at: '2026-07-03T01:00:00.000+02:00', released_at: null,
    }).execute();

    const renewed = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000024', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000025',
      now: '2026-07-03T00:00:00.000Z', expiresAt: '2026-07-03T00:10:00.000Z',
    });
    expect(renewed?.lease.expiresAt).toBe('2026-07-03T00:10:00.000Z');
  });

  it('queues an exact late provider image for bounded cleanup', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000021',
      buildId: '20000000-0000-4000-8000-000000000021', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'failed' })
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();

    expect(await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 121, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:01:00.000Z',
    })).toBe(false);
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:02:00.000Z', 10)).toEqual([
      expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 121 }),
    ]);
  });

  it('revokes immediately and retires only after active leases are released', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2',
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000005',
      buildId: '20000000-0000-4000-8000-000000000005',
      now: '2026-07-03T00:00:00.000Z',
    });
    await advanceToValidating(db, enqueued.snapshot.snapshotId, enqueued.build.buildId);
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 43,
      providerImageStatus: 'available',
      imageDiskGb: 40,
      imageArchitecture: 'x86',
      now: '2026-07-03T00:04:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'validation_boot', status: 'running', lease_expires_at: '2026-07-03T00:10:00.000Z',
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await markGoldenSnapshotReady(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, {
      validationSummary: {
        exactBundle: true,
        healthy: true,
        freshActivation: true,
        uniqueMachineId: true,
        uniqueSshHostKey: true,
        forbiddenStateAbsent: true,
      },
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      now: '2026-07-03T00:05:00.000Z',
    });
    const selected = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v2',
      compatibility,
      serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000005',
      purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000005',
      now: '2026-07-03T00:05:30.000Z',
      expiresAt: '2026-07-03T00:15:30.000Z',
    });
    expect(selected).toBeDefined();
    expect(await retireGoldenSnapshot(db, enqueued.snapshot.snapshotId, 'retention', '2026-07-03T00:06:00.000Z')).toBe(false);
    expect(await retireGoldenSnapshot(db, enqueued.snapshot.snapshotId, 'retention', '2026-07-03T00:16:00.000Z')).toBe(false);

    expect(await revokeGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'base_generation_revoked', '2026-07-03T00:06:15.000Z',
    )).toBe(true);
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'quarantined' });
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:06:20.000Z', 10)).toEqual([]);
    expect(await retireGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'revoked', '2026-07-03T00:06:20.000Z',
    )).toBe(false);

    await releaseGoldenSnapshotLease(db, selected!.lease.leaseId, '2026-07-03T00:06:30.000Z');
    expect(await getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).toMatchObject({ state: 'retiring' });
    expect(await listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:06:30.000Z', 10)).toEqual([
      expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 43 }),
    ]);
  });

  it('atomically refuses retirement of current-channel and sole-compatible ready images', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000012',
      buildId: '20000000-0000-4000-8000-000000000012', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'ready', ready_at: '2026-07-03T00:01:00.000Z' })
      .where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await promoteHostBundleChannel(db, 'stable', 'v1', '2026-07-03T00:02:00.000Z');
    expect(await retireGoldenSnapshot(db, enqueued.snapshot.snapshotId, 'retention', '2026-07-03T00:03:00.000Z')).toBe(false);
    await db.executor.deleteFrom('host_bundle_channels').where('channel', '=', 'stable').execute();
    await db.executor.deleteFrom('host_bundle_release_channels').where('channel', '=', 'stable').execute();
    expect(await retireGoldenSnapshot(db, enqueued.snapshot.snapshotId, 'retention', '2026-07-03T00:04:00.000Z')).toBe(false);
  });

  it('quarantines a current-channel image immediately and cleans it after its lease drains', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000033',
      buildId: '20000000-0000-4000-8000-000000000033', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', ready_at: '2026-07-03T00:01:00.000Z', provider_image_id: 933,
      provider_image_status: 'available', image_disk_gb: 40, image_architecture: 'x86',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await promoteHostBundleChannel(db, 'stable', 'v1', '2026-07-03T00:02:00.000Z');
    const selected = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000033', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000033',
      now: '2026-07-03T00:03:00.000Z', expiresAt: '2026-07-03T00:13:00.000Z',
    });
    expect(selected).toBeDefined();
    await expect(revokeGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'integrity_revoked', '2026-07-03T00:04:00.000Z',
    )).resolves.toBe(true);
    await expect(retireGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'revoked', '2026-07-03T00:05:00.000Z',
    )).resolves.toBe(false);
    await releaseGoldenSnapshotLease(db, selected!.lease.leaseId, '2026-07-03T00:06:00.000Z');
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'retiring',
    });
    await expect(listPendingGoldenSnapshotCleanup(
      db, '2026-07-03T00:06:00.000Z', 10,
    )).resolves.toContainEqual(expect.objectContaining({
      resourceType: 'snapshot_image', providerResourceId: 933,
    }));
  });

  it('retains the bounded orphan deadline when revoking an in-flight provider create', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000034',
      buildId: '20000000-0000-4000-8000-000000000034', now: '2026-07-03T00:00:00.000Z',
    });
    const deadline = '2026-07-03T00:30:00.000Z';
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'builder_create', status: 'running', pending_operation: `builder:${enqueued.build.buildId}`,
      callback_expires_at: deadline,
    }).where('build_id', '=', enqueued.build.buildId).execute();

    await expect(revokeGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'operator_revoked', '2026-07-03T00:01:00.000Z',
    )).resolves.toBe(true);
    await expect(db.executor.selectFrom('golden_snapshot_builds')
      .select(['status', 'pending_operation', 'callback_expires_at'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow()).resolves.toEqual({
      status: 'failed',
      pending_operation: `builder:${enqueued.build.buildId}`,
      callback_expires_at: deadline,
    });
  });

  it('retires a freshness-expired channel snapshot once no active lease remains', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000013',
      buildId: '20000000-0000-4000-8000-000000000013', now: '2026-07-01T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', ready_at: '2026-07-01T00:01:00.000Z', provider_image_id: 113,
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await promoteHostBundleChannel(db, 'stable', 'v1', '2026-07-01T00:02:00.000Z');

    expect(await retireGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'freshness_expired', '2026-07-03T00:00:00.000Z', 2,
      24 * 60 * 60 * 1000,
    )).toBe(true);
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId)).resolves.toMatchObject({
      state: 'retiring',
    });
  });

  it('protects only the bounded newest rollback history per channel', async () => {
    const historical = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000025',
      buildId: '20000000-0000-4000-8000-000000000025', now: '2026-07-03T00:00:00.000Z',
    });
    const current = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000026',
      buildId: '20000000-0000-4000-8000-000000000026', now: '2026-07-03T00:00:01.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', ready_at: '2026-07-03T00:01:00.000Z', image_disk_gb: 40,
      image_architecture: 'x86', provider_image_status: 'available',
    }).where('snapshot_id', 'in', [historical.snapshot.snapshotId, current.snapshot.snapshotId]).execute();
    await promoteHostBundleChannel(db, 'stable', 'v1', '2026-07-03T00:02:00.000Z');
    await promoteHostBundleChannel(db, 'stable', 'v2', '2026-07-03T00:03:00.000Z');

    expect(await retireGoldenSnapshot(
      db, historical.snapshot.snapshotId, 'retention', '2026-07-03T00:04:00.000Z', 1,
    )).toBe(true);
  });

  it('keeps an expired unreconciled lease protected from retirement', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000024',
      buildId: '20000000-0000-4000-8000-000000000024', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'failed', provider_image_id: 124, failure_code: 'validation_failed',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000024',
      snapshot_id: enqueued.snapshot.snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000024',
      purpose: 'provision',
      target_bundle_version: 'v1',
      created_at: '2026-07-03T00:01:00.000Z',
      expires_at: '2026-07-03T00:02:00.000Z',
      released_at: null,
    }).execute();

    expect(await retireGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'failed_build', '2026-07-03T00:03:00.000Z',
    )).toBe(false);
    await releaseGoldenSnapshotLease(db, '40000000-0000-4000-8000-000000000024', '2026-07-03T00:04:00.000Z');
    expect(await retireGoldenSnapshot(
      db, enqueued.snapshot.snapshotId, 'failed_build', '2026-07-03T00:05:00.000Z',
    )).toBe(true);
  });

  it('releases a terminal expired lease and retires its quarantined snapshot', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000041',
      buildId: '20000000-0000-4000-8000-000000000041', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'quarantined', provider_image_id: 941, failure_code: 'operator_revoked',
      quarantined_at: '2026-07-03T00:01:00.000Z',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000041', snapshot_id: enqueued.snapshot.snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000041', purpose: 'provision',
      target_bundle_version: 'v1', created_at: '2026-07-03T00:00:00.000Z',
      expires_at: '2026-07-03T00:10:00.000Z', released_at: null,
    }).execute();

    await expect(reconcileExpiredGoldenSnapshotLeases(
      db, '2026-07-03T00:11:00.000Z', 10,
    )).resolves.toBe(1);
    await expect(getGoldenSnapshot(db, enqueued.snapshot.snapshotId))
      .resolves.toMatchObject({ state: 'retiring' });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:12:00.000Z', 10))
      .resolves.toContainEqual(expect.objectContaining({
        resourceType: 'snapshot_image', providerResourceId: 941,
      }));
  });

  it('serializes create intents with generation revocation and denies overlapping work', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000053',
      buildId: '20000000-0000-4000-8000-000000000053', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', provider_image_id: 953, provider_image_status: 'available',
      image_architecture: 'x86', image_disk_gb: 40, ready_at: '2026-07-03T00:01:00.000Z',
    }).where('snapshot_id', '=', enqueued.snapshot.snapshotId).execute();
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000053', snapshot_id: enqueued.snapshot.snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000053', purpose: 'provision',
      target_bundle_version: 'v1', created_at: '2026-07-03T00:01:00.000Z',
      expires_at: '2026-07-03T00:11:00.000Z', released_at: null,
    }).execute();
    await expect(createGoldenSnapshotCreateIntent(db, {
      intentId: '50000000-0000-4000-8000-000000000053',
      snapshotId: enqueued.snapshot.snapshotId,
      leaseId: '40000000-0000-4000-8000-000000000053',
      machineId: '30000000-0000-4000-8000-000000000053', purpose: 'provision',
      rolloutGeneration: 1, now: '2026-07-03T00:02:00.000Z',
    })).resolves.toMatchObject({ state: 'pending' });

    await revokeGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, 'base_compromised', '2026-07-03T00:03:00.000Z',
    );
    await expect(getGoldenSnapshotCreateIntent(db, '40000000-0000-4000-8000-000000000053'))
      .resolves.toMatchObject({ state: 'denied', completedAt: null });
  });

  it('marks a base generation revoked immediately and quarantines it in bounded batches', async () => {
    const first = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000021',
      buildId: '20000000-0000-4000-8000-000000000021', now: '2026-07-03T00:00:00.000Z',
    });
    const second = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000022',
      buildId: '20000000-0000-4000-8000-000000000022', now: '2026-07-03T00:00:00.000Z',
    });
    const otherGeneration = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1',
      compatibility: { ...compatibility, baseGeneration: 'ubuntu-24.04-v2' },
      snapshotId: '10000000-0000-4000-8000-000000000023',
      buildId: '20000000-0000-4000-8000-000000000023', now: '2026-07-03T00:00:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', ready_at: '2026-07-03T00:01:00.000Z', image_disk_gb: 40,
      image_architecture: 'x86', provider_image_status: 'available',
    })
      .where('snapshot_id', 'in', [first.snapshot.snapshotId, second.snapshot.snapshotId, otherGeneration.snapshot.snapshotId])
      .execute();
    await db.executor.updateTable('golden_snapshots').set({ provider_image_id: 221 })
      .where('snapshot_id', '=', first.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshots').set({ provider_image_id: 222 })
      .where('snapshot_id', '=', second.snapshot.snapshotId).execute();
    const lease = await selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v1', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000021', purpose: 'recover',
      leaseId: '40000000-0000-4000-8000-000000000021',
      now: '2026-07-03T00:01:30.000Z', expiresAt: '2026-07-03T00:11:30.000Z',
    });
    expect(lease?.snapshot.snapshotId).toBe(first.snapshot.snapshotId);

    await expect(revokeGoldenSnapshotBaseGeneration(
      db,
      compatibility.baseGeneration,
      'base_generation_revoked',
      '2026-07-03T00:02:00.000Z',
    )).resolves.toBe(true);
    await expect(revokeGoldenSnapshotBaseGeneration(
      db,
      compatibility.baseGeneration,
      'base_generation_revoked',
      '2026-07-03T00:03:00.000Z',
    )).resolves.toBe(false);

    await expect(selectAndLeaseGoldenSnapshot(db, {
      targetBundleVersion: 'v2', compatibility, serverDiskGb: 80,
      machineId: '30000000-0000-4000-8000-000000000022', purpose: 'provision',
      leaseId: '40000000-0000-4000-8000-000000000022',
      now: '2026-07-03T00:03:00.000Z', expiresAt: '2026-07-03T00:13:00.000Z',
    })).resolves.toBeUndefined();
    await expect(enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000024',
      buildId: '20000000-0000-4000-8000-000000000024', now: '2026-07-03T00:03:00.000Z',
    })).rejects.toThrow('Base generation is revoked');

    await expect(reconcileRevokedGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, '2026-07-03T00:03:30.000Z', 1,
    )).resolves.toEqual({ processed: 1, hasMore: true });
    await expect(reconcileRevokedGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, '2026-07-03T00:03:31.000Z', 1,
    )).resolves.toEqual({ processed: 1, hasMore: false });
    await expect(reconcileRevokedGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, '2026-07-03T00:03:32.000Z', 1,
    )).resolves.toEqual({ processed: 0, hasMore: false });

    await expect(getGoldenSnapshot(db, first.snapshot.snapshotId)).resolves.toMatchObject({ state: 'quarantined' });
    await expect(getGoldenSnapshot(db, second.snapshot.snapshotId)).resolves.toMatchObject({ state: 'quarantined' });
    await expect(getGoldenSnapshot(db, otherGeneration.snapshot.snapshotId)).resolves.toMatchObject({ state: 'ready' });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:03:33.000Z', 10)).resolves.toEqual([
      expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 222 }),
    ]);
    await releaseGoldenSnapshotLease(db, lease!.lease.leaseId, '2026-07-03T00:04:00.000Z');
    await expect(getGoldenSnapshot(db, first.snapshot.snapshotId)).resolves.toMatchObject({ state: 'retiring' });
    await expect(listPendingGoldenSnapshotCleanup(db, '2026-07-03T00:05:00.000Z', 10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 221 }),
        expect.objectContaining({ resourceType: 'snapshot_image', providerResourceId: 222 }),
      ]),
    );
  });

  it('preserves an ambiguous provider-operation deadline while revoking its build', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000038',
      buildId: '20000000-0000-4000-8000-000000000038', now: '2026-07-03T00:00:00.000Z',
    });
    const reconciliationDeadline = '2026-07-03T01:00:00.000Z';
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'snapshot_create', pending_operation: 'snapshot_create:ambiguous',
      callback_phase: 'sanitized', callback_token_hash: 'a'.repeat(64),
      callback_expires_at: reconciliationDeadline,
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await revokeGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, 'base_generation_revoked', '2026-07-03T00:10:00.000Z',
    );

    await reconcileRevokedGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, '2026-07-03T00:11:00.000Z', 10,
    );

    await expect(db.executor.selectFrom('golden_snapshot_builds').selectAll()
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow()).resolves.toMatchObject({
      status: 'failed', pending_operation: 'snapshot_create:ambiguous',
      callback_phase: null, callback_token_hash: null, callback_expires_at: reconciliationDeadline,
    });
  });

  it('prevents a revoked generation from becoming ready while bounded cleanup catches up', async () => {
    const enqueued = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility, testMode: true,
      snapshotId: '10000000-0000-4000-8000-000000000032',
      buildId: '20000000-0000-4000-8000-000000000032', now: '2026-07-03T00:00:00.000Z',
    });
    await advanceToValidating(db, enqueued.snapshot.snapshotId, enqueued.build.buildId);
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId,
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      providerImageId: 532, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: '2026-07-03T00:04:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({ phase: 'validation_boot' })
      .where('build_id', '=', enqueued.build.buildId).execute();
    await revokeGoldenSnapshotBaseGeneration(
      db, compatibility.baseGeneration, 'base_generation_revoked', '2026-07-03T00:04:30.000Z',
    );

    await expect(markGoldenSnapshotReady(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, {
      validationSummary: {
        exactBundle: true, healthy: true, freshActivation: true, uniqueMachineId: true,
        uniqueSshHostKey: true, forbiddenStateAbsent: true,
      },
      expectedLeaseExpiresAt: '2026-07-03T00:10:00.000Z',
      now: '2026-07-03T00:05:00.000Z',
    })).rejects.toThrow('Base generation is revoked');
    await expect(db.executor.selectFrom('golden_snapshot_builds').select(['status', 'phase'])
      .where('build_id', '=', enqueued.build.buildId).executeTakeFirstOrThrow())
      .resolves.toEqual({ status: 'running', phase: 'validation_boot' });
  });

  it('locks builds before snapshots in readiness and revocation transactions', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-repository.ts', 'utf8');
    for (const [startName, endName, buildLock] of [
      ['export async function markGoldenSnapshotReady', 'const SelectInputSchema', 'const build = await'],
      ['export async function revokeGoldenSnapshot(', 'export async function revokeGoldenSnapshotBaseGeneration', 'const build = buildIdentity'],
    ]) {
      const start = source.indexOf(startName);
      const section = source.slice(start, source.indexOf(endName, start));
      expect(section.indexOf(buildLock)).toBeLessThan(section.indexOf('const snapshot = await'));
    }
  });

  it('locks a retirement compatibility class in deterministic order before choosing a fallback', async () => {
    const source = await readFile('packages/platform/src/golden-snapshot-repository.ts', 'utf8');
    const start = source.indexOf('export async function retireGoldenSnapshot');
    const end = source.indexOf('export async function listPendingGoldenSnapshotCleanup', start);
    const retirement = source.slice(start, end);

    expect(retirement).toContain(
      "const retirementTarget = await trx.executor.selectFrom('golden_snapshots').selectAll()\n"
      + "      .where('snapshot_id', '=', snapshotId).executeTakeFirst()",
    );
    expect(retirement).toContain(".where('compatibility_key', '=', retirementTarget.compatibility_key)");
    expect(retirement).toContain(".where('test_mode', '=', retirementTarget.test_mode)");
    expect(retirement).toContain(".orderBy('snapshot_id').forUpdate().execute()");
    expect(retirement).not.toContain(".where('expires_at', '>', now)");
    expect(retirement.indexOf(".orderBy('snapshot_id').forUpdate().execute()"))
      .toBeLessThan(retirement.indexOf("const snapshotRow = compatibilityRows.find"));
  });

  it('serializes channel promotion and retirement through the immutable release row', async () => {
    const repositorySource = await readFile('packages/platform/src/golden-snapshot-repository.ts', 'utf8');
    const retirementStart = repositorySource.indexOf('export async function retireGoldenSnapshot');
    const retirementEnd = repositorySource.indexOf('export async function listPendingGoldenSnapshotCleanup', retirementStart);
    const retirement = repositorySource.slice(retirementStart, retirementEnd);
    const dbSource = await readFile('packages/platform/src/db.ts', 'utf8');
    const promotionStart = dbSource.indexOf('export async function promoteHostBundleChannel');
    const promotionEnd = dbSource.indexOf('export async function getHostBundleChannel', promotionStart);
    const promotion = dbSource.slice(promotionStart, promotionEnd);

    expect(retirement).toContain(".where('version', '=', snapshotRow.bundle_version).forUpdate().executeTakeFirst()");
    expect(promotion).toContain(".where('version', '=', version)");
    expect(promotion.indexOf(".where('version', '=', version)"))
      .toBeLessThan(promotion.indexOf('.forUpdate()'));
  });

  it('does not treat a test-mode image as the production retirement fallback', async () => {
    const production = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v1', compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000013',
      buildId: '20000000-0000-4000-8000-000000000013', now: '2026-07-03T00:00:00.000Z',
    });
    const testOnly = await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2', compatibility, testMode: true,
      snapshotId: '10000000-0000-4000-8000-000000000014',
      buildId: '20000000-0000-4000-8000-000000000014', now: '2026-07-03T00:00:01.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', ready_at: '2026-07-03T00:01:00.000Z', provider_image_id: 113,
    }).where('snapshot_id', '=', production.snapshot.snapshotId).execute();
    await db.executor.updateTable('golden_snapshots').set({
      state: 'ready', ready_at: '2026-07-03T00:01:01.000Z', provider_image_id: 114,
    }).where('snapshot_id', '=', testOnly.snapshot.snapshotId).execute();

    expect(await retireGoldenSnapshot(
      db, production.snapshot.snapshotId, 'retention', '2026-07-03T00:02:00.000Z',
    )).toBe(false);
  });
});
