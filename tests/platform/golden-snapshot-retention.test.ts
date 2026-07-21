import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertUserMachine, promoteHostBundleChannel, type PlatformDB, upsertHostBundleRelease } from '../../packages/platform/src/db.js';
import {
  advanceGoldenSnapshot, claimGoldenSnapshotBuild,
  enforceGoldenSnapshotRetention,
  enqueueGoldenSnapshotBuild,
  markGoldenSnapshotReady,
  recordGoldenSnapshotProviderImage,
  revokeGoldenSnapshot,
} from '../../packages/platform/src/golden-snapshot-repository.js';
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
const validationSummary = {
  exactBundle: true as const,
  healthy: true as const,
  freshActivation: true as const,
  uniqueMachineId: true as const,
  uniqueSshHostKey: true as const,
  forbiddenStateAbsent: true as const,
};

describe('golden snapshot retention', () => {
  let db: PlatformDB;
  beforeEach(async () => ({ db } = await createTestPlatformDb()));
  afterEach(async () => destroyTestPlatformDb(db));

  async function ready(index: number) {
    const version = `v${index}`;
    const at = `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`;
    await upsertHostBundleRelease(db, {
      version, gitCommit: `${index}`.repeat(7), buildTime: at,
      bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, checksumKey: null,
      sha256: index.toString(16).repeat(64), size: 100, createdAt: at,
    });
    const snapshotId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const buildId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const enqueued = await enqueueGoldenSnapshotBuild(db, { bundleVersion: version, compatibility, snapshotId, buildId, now: at });
    const claimed = await claimGoldenSnapshotBuild(db, buildId, at, '2026-08-01T00:10:00.000Z', 5);
    const fence = claimed!.leaseExpiresAt!;
    await advanceGoldenSnapshot(db, snapshotId, buildId, fence, 'candidate', 'building', at);
    await advanceGoldenSnapshot(db, snapshotId, buildId, fence, 'building', 'sanitizing', at);
    await advanceGoldenSnapshot(db, snapshotId, buildId, fence, 'sanitizing', 'validating', at);
    await recordGoldenSnapshotProviderImage(db, snapshotId, {
      buildId: enqueued.build.buildId, expectedLeaseExpiresAt: fence,
      providerImageId: 300 + index, providerImageStatus: 'available', imageDiskGb: 40,
      imageArchitecture: 'x86', now: at,
    });
    const leaseExpiresAt = new Date(new Date(at).getTime() + 600_000).toISOString();
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'validation_boot', status: 'running', lease_expires_at: leaseExpiresAt,
    }).where('build_id', '=', enqueued.build.buildId).execute();
    await markGoldenSnapshotReady(db, snapshotId, enqueued.build.buildId, {
      validationSummary, expectedLeaseExpiresAt: leaseExpiresAt, now: at,
    });
    return { version, snapshotId };
  }

  it('retires only unleased, non-channel, non-rollback snapshots and preserves one compatible image', async () => {
    const oldest = await ready(1);
    const rollback = await ready(2);
    const leased = await ready(3);
    const newest = await ready(4);
    await promoteHostBundleChannel(db, 'stable', rollback.version, '2026-07-04T01:00:00.000Z');
    await promoteHostBundleChannel(db, 'stable', newest.version, '2026-07-04T02:00:00.000Z');
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000003', snapshot_id: leased.snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000003', purpose: 'provision',
      target_bundle_version: newest.version, created_at: '2026-07-04T00:00:00.000Z',
      expires_at: '2026-07-04T03:00:00.000Z', released_at: null,
    }).execute();

    const result = await enforceGoldenSnapshotRetention(db, {
      retentionLimit: 3, rollbackVersionsPerChannel: 1,
      now: '2026-07-04T02:30:00.000Z', quotaPressure: false,
    });

    expect(result).toEqual({ retiredSnapshotIds: [oldest.snapshotId], blocked: false });
    expect((await db.executor.selectFrom('golden_snapshots').select(['snapshot_id', 'state']).execute()))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ snapshot_id: rollback.snapshotId, state: 'ready' }),
        expect.objectContaining({ snapshot_id: leased.snapshotId, state: 'ready' }),
        expect.objectContaining({ snapshot_id: newest.snapshotId, state: 'ready' }),
      ]));
  });

  it('refuses quota-pressure deletion when every candidate is protected', async () => {
    const only = await ready(1);
    await promoteHostBundleChannel(db, 'stable', only.version, '2026-07-02T00:00:00.000Z');
    await expect(enforceGoldenSnapshotRetention(db, {
      retentionLimit: 1, rollbackVersionsPerChannel: 1,
      now: '2026-07-03T00:00:00.000Z', quotaPressure: true,
    })).resolves.toEqual({ retiredSnapshotIds: [], blocked: true });
  });

  it('retires a freshness-expired channel snapshot even below the retention limit', async () => {
    const stale = await ready(1);
    await promoteHostBundleChannel(db, 'stable', stale.version, '2026-07-01T01:00:00.000Z');

    await expect(enforceGoldenSnapshotRetention(db, {
      retentionLimit: 20, rollbackVersionsPerChannel: 2,
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      now: '2026-07-03T00:00:00.000Z', quotaPressure: false,
    })).resolves.toEqual({ retiredSnapshotIds: [stale.snapshotId], blocked: false });
  });

  it('does not report retention blocked when the only freshness-expired image is leased', async () => {
    const stale = await ready(1);
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000091', snapshot_id: stale.snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000091', purpose: 'provision',
      target_bundle_version: stale.version, created_at: '2026-07-01T01:00:00.000Z',
      expires_at: '2026-07-04T00:00:00.000Z', released_at: null,
    }).execute();

    await expect(enforceGoldenSnapshotRetention(db, {
      retentionLimit: 20, rollbackVersionsPerChannel: 2,
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      now: '2026-07-03T00:00:00.000Z', quotaPressure: false,
    })).resolves.toEqual({ retiredSnapshotIds: [], blocked: false });
  });

  it('releases bounded expired recovery leases only after machine recovery is terminal', async () => {
    const snapshot = await ready(1);
    await insertUserMachine(db, {
      machineId: '30000000-0000-4000-8000-000000000099', clerkUserId: 'user_lease', handle: 'lease-test',
      runtimeSlot: 'primary', developerTools: [], status: 'running', imageVersion: 'v1',
      provisionedAt: '2026-07-01T00:00:00.000Z',
    });
    await db.executor.insertInto('golden_snapshot_leases').values({
      lease_id: '40000000-0000-4000-8000-000000000099', snapshot_id: snapshot.snapshotId,
      machine_id: '30000000-0000-4000-8000-000000000099', purpose: 'recover', target_bundle_version: 'v1',
      created_at: '2026-07-01T00:00:00.000Z', expires_at: '2026-07-01T00:10:00.000Z', released_at: null,
    }).execute();
    await enforceGoldenSnapshotRetention(db, {
      retentionLimit: 1, rollbackVersionsPerChannel: 1,
      now: '2026-07-02T00:00:00.000Z', quotaPressure: false,
    });
    expect(await db.executor.selectFrom('golden_snapshot_leases').select('released_at')
      .where('lease_id', '=', '40000000-0000-4000-8000-000000000099').executeTakeFirst()).toEqual({
      released_at: '2026-07-02T00:00:00.000Z',
    });
  });

  it('retires failed or quarantined provider images even below the ready retention limit', async () => {
    const revoked = await ready(1);
    await revokeGoldenSnapshot(db, revoked.snapshotId, 'validation_revoked', '2026-07-02T00:00:00.000Z');

    await expect(enforceGoldenSnapshotRetention(db, {
      retentionLimit: 20, rollbackVersionsPerChannel: 1,
      now: '2026-07-03T00:00:00.000Z', quotaPressure: false,
    })).resolves.toEqual({ retiredSnapshotIds: [revoked.snapshotId], blocked: false });
    expect(await db.executor.selectFrom('golden_snapshots').select('state')
      .where('snapshot_id', '=', revoked.snapshotId).executeTakeFirst()).toEqual({ state: 'retiring' });
  });

  it('preserves rollback history independently for a quiet channel', async () => {
    const rollback = await ready(1);
    const current = await ready(2);
    const disposable = await ready(3);
    await ready(4);
    await promoteHostBundleChannel(db, 'stable', rollback.version, '2026-07-05T00:00:00.000Z');
    await promoteHostBundleChannel(db, 'stable', current.version, '2026-07-05T01:00:00.000Z');

    const noisyReleases = Array.from({ length: 101 }, (_, index) => {
      const version = `noise-${index}`;
      const promotedAt = new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
      return {
        release: {
          version, channel: null, git_commit: `noise-${index}`, git_ref: null,
          build_time: promotedAt, bundle_key: `system-bundles/${version}/matrix-host-bundle.tar.gz`,
          checksum_key: null, incremental_manifest_key: null, incremental_manifest_sha256: null,
          sha256: index.toString(16).padStart(64, '0'), size: 100, severity: 'normal',
          update_type: 'manual', changelog: null, created_at: promotedAt,
        },
        history: { channel: 'dev', version, promoted_at: promotedAt },
      };
    });
    await db.transaction(async (trx) => {
      await trx.executor.insertInto('host_bundle_releases').values(noisyReleases.map((row) => row.release)).execute();
      await trx.executor.insertInto('host_bundle_release_channels').values(noisyReleases.map((row) => row.history)).execute();
      await trx.executor.insertInto('host_bundle_channels').values({
        channel: 'dev', version: 'noise-100', updated_at: noisyReleases[100]!.history.promoted_at,
      }).execute();
    });

    const result = await enforceGoldenSnapshotRetention(db, {
      retentionLimit: 3, rollbackVersionsPerChannel: 1,
      now: '2026-08-02T00:00:00.000Z', quotaPressure: false,
    });
    expect(result).toEqual({ retiredSnapshotIds: [disposable.snapshotId], blocked: false });
    expect(await db.executor.selectFrom('golden_snapshots').select('state')
      .where('snapshot_id', '=', rollback.snapshotId).executeTakeFirst()).toEqual({ state: 'ready' });
  });

  it('retires channel history older than the configured rollback window', async () => {
    const expiredHistory = await ready(1);
    const rollback = await ready(2);
    const current = await ready(3);
    await promoteHostBundleChannel(db, 'stable', expiredHistory.version, '2026-07-04T01:00:00.000Z');
    await promoteHostBundleChannel(db, 'stable', rollback.version, '2026-07-04T02:00:00.000Z');
    await promoteHostBundleChannel(db, 'stable', current.version, '2026-07-04T03:00:00.000Z');

    await expect(enforceGoldenSnapshotRetention(db, {
      retentionLimit: 2, rollbackVersionsPerChannel: 1,
      now: '2026-07-04T04:00:00.000Z', quotaPressure: false,
    })).resolves.toEqual({ retiredSnapshotIds: [expiredHistory.snapshotId], blocked: false });
  });

  it('continues a bounded sweep after one candidate retirement fails', async () => {
    const first = await ready(1);
    const second = await ready(2);
    await ready(3);
    const originalTransaction = db.transaction.bind(db);
    let calls = 0;
    const flakyDb = {
      ...db,
      transaction: async <T>(fn: (trx: PlatformDB) => Promise<T>) => {
        calls += 1;
        if (calls === 1) throw new Error('synthetic transient failure');
        return originalTransaction(fn);
      },
    } as PlatformDB;

    const result = await enforceGoldenSnapshotRetention(flakyDb, {
      retentionLimit: 1, rollbackVersionsPerChannel: 0,
      now: '2026-07-04T00:00:00.000Z', quotaPressure: false,
    });
    expect(result).toEqual({ retiredSnapshotIds: [second.snapshotId], blocked: true });
    expect(await db.executor.selectFrom('golden_snapshots').select('state')
      .where('snapshot_id', '=', first.snapshotId).executeTakeFirst()).toEqual({ state: 'ready' });
  });
});
