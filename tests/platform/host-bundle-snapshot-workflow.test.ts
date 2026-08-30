import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getHostBundleChannel,
  promoteHostBundleChannel,
  upsertHostBundleRelease,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  enqueueGoldenSnapshotBuild,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import {
  getGoldenSnapshotCoarseStatuses,
  promoteHostBundleChannelWithStableSnapshot,
  registerHostBundleReleaseWithStableSnapshot,
} from '../../packages/platform/src/golden-snapshot-release-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import {
  enqueueGoldenSnapshot,
  formatGoldenSnapshotEnqueueFailure,
  GoldenSnapshotEnqueueError,
  isEligibleSnapshotRelease,
} from '../../scripts/enqueue-golden-snapshot.mjs';
import { resolveReleaseSnapshotEligibility } from '../../scripts/release-snapshot-eligibility.mjs';

const root = process.cwd();

describe('host bundle golden snapshot release hook', () => {
  it('accepts immutable main, tag, and trusted manual customer-channel releases', () => {
    expect(isEligibleSnapshotRelease({ eventName: 'push', refType: 'branch', refName: 'main' })).toBe(true);
    expect(isEligibleSnapshotRelease({ eventName: 'push', refType: 'tag', refName: 'v0.9.1' })).toBe(true);
    expect(isEligibleSnapshotRelease({ eventName: 'push', refType: 'branch', refName: 'preview-123' })).toBe(false);
    expect(isEligibleSnapshotRelease({
      eventName: 'workflow_dispatch', refType: 'branch', refName: 'release-candidate', channel: 'stable',
    })).toBe(true);
    expect(isEligibleSnapshotRelease({
      eventName: 'workflow_dispatch', refType: 'branch', refName: 'release-candidate',
    })).toBe(false);
  });

  it('enqueues with platform auth, a bounded request, redirect rejection, and a generic result', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      snapshotId: '10000000-0000-4000-8000-000000000001',
      buildId: '20000000-0000-4000-8000-000000000001',
      status: 'queued',
      reused: false,
      providerError: 'must not escape',
    }), { status: 202, headers: { 'content-type': 'application/json' } }));

    await expect(enqueueGoldenSnapshot({
      platformUrl: 'https://app.matrix-os.com/',
      platformSecret: 'test-secret',
      bundleVersion: 'v2026.07.19-1053',
      fetchImpl,
    })).resolves.toEqual({ status: 'queued', reused: false });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.matrix-os.com/system-bundles/snapshot-builds',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ authorization: 'Bearer test-secret' }),
        body: JSON.stringify({ bundleVersion: 'v2026.07.19-1053' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('does not expose provider or response details when enqueueing fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('provider quota secret', { status: 503 }));
    await expect(enqueueGoldenSnapshot({
      platformUrl: 'https://app.matrix-os.com',
      platformSecret: 'test-secret',
      bundleVersion: 'v2026.07.19-1053',
      fetchImpl,
    })).rejects.toThrow('Snapshot build enqueue failed');
  });

  it('reports a safe disabled category without exposing response details', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'Snapshot builds disabled',
      providerError: 'must not escape',
    }), { status: 503, headers: { 'content-type': 'application/json' } }));

    const failure = await enqueueGoldenSnapshot({
      platformUrl: 'https://app.matrix-os.com',
      platformSecret: 'test-secret',
      bundleVersion: 'v2026.07.19-1053',
      fetchImpl,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GoldenSnapshotEnqueueError);
    expect(failure).toMatchObject({
      message: 'Snapshot build enqueue failed',
      category: 'disabled',
    });
    expect(String(failure)).not.toContain('must not escape');
  });

  it('records a coarse diagnostic when a disabled response cannot be classified', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const failure = await enqueueGoldenSnapshot({
      platformUrl: 'https://app.matrix-os.com',
      platformSecret: 'test-secret',
      bundleVersion: 'v2026.07.19-1053',
      fetchImpl: vi.fn(async () => new Response('provider secret: malformed', { status: 503 })),
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: 'Snapshot build enqueue failed',
      category: 'unavailable',
    });
    expect(warn).toHaveBeenCalledWith(
      '[golden-snapshot-enqueue] Response classification failed (invalid_json).',
    );
    expect(warn.mock.calls.flat().join(' ')).not.toContain('provider secret');
  });

  it('formats only allowlisted enqueue diagnostics for CI', () => {
    expect(formatGoldenSnapshotEnqueueFailure(new GoldenSnapshotEnqueueError('disabled')))
      .toBe('Golden snapshot build enqueue failed (disabled). Host bundle publication and fleet deployment are unaffected.');
    expect(formatGoldenSnapshotEnqueueFailure(new Error('provider quota secret')))
      .toBe('Golden snapshot build enqueue failed (unavailable). Host bundle publication and fleet deployment are unaffected.');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [409, 'conflict'],
    [500, 'unavailable'],
  ])('maps HTTP %i to the safe %s category', async (status, category) => {
    const failure = await enqueueGoldenSnapshot({
      platformUrl: 'https://app.matrix-os.com',
      platformSecret: 'test-secret',
      bundleVersion: 'v2026.07.19-1053',
      fetchImpl: vi.fn(async () => new Response('provider details must not escape', { status })),
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: 'Snapshot build enqueue failed',
      category,
    });
    expect(String(failure)).not.toContain('provider details');
  });

  it('uses platform stable promotion as the only snapshot enqueue trigger', () => {
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');
    const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));

    expect(workflow).not.toContain('\n  enqueue-golden-snapshot:');
    expect(workflow).not.toContain('scripts/enqueue-golden-snapshot.mjs');
    expect(deployJob).toContain('needs: [dev-bundle-gate, build, publish]');
    expect(deployJob).not.toContain('enqueue-golden-snapshot');
  });

  it('deploys production golden snapshot selection at 100 percent', () => {
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
    const candidateDeploy = workflow.slice(
      workflow.indexOf('      - name: Deploy tagged revision'),
      workflow.indexOf('      - name: Smoke candidate revision'),
    );
    const productionDeploy = workflow.slice(
      workflow.indexOf('      - name: Deploy production-role revision'),
      workflow.indexOf('      - name: Promote revision'),
    );

    expect(workflow).toContain(
      "GOLDEN_SNAPSHOT_BUILDS_ENABLED: ${{ vars.GOLDEN_SNAPSHOT_BUILDS_ENABLED || 'false' }}",
    );
    expect(workflow).toContain("GOLDEN_SNAPSHOTS_ENABLED: 'true'");
    expect(workflow).toContain("GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100'");
    expect(candidateDeploy).toContain('GOLDEN_SNAPSHOT_BUILDS_ENABLED=${GOLDEN_SNAPSHOT_BUILDS_ENABLED}');
    expect(candidateDeploy).toContain('GOLDEN_SNAPSHOTS_ENABLED=${GOLDEN_SNAPSHOTS_ENABLED}');
    expect(candidateDeploy).toContain('GOLDEN_SNAPSHOT_ROLLOUT_PERCENT=${GOLDEN_SNAPSHOT_ROLLOUT_PERCENT}');
    expect(productionDeploy).toContain('GOLDEN_SNAPSHOT_BUILDS_ENABLED=${GOLDEN_SNAPSHOT_BUILDS_ENABLED}');
    expect(productionDeploy).toContain('GOLDEN_SNAPSHOTS_ENABLED=${GOLDEN_SNAPSHOTS_ENABLED}');
    expect(productionDeploy).toContain('GOLDEN_SNAPSHOT_ROLLOUT_PERCENT=${GOLDEN_SNAPSHOT_ROLLOUT_PERCENT}');

    const deployedContract = workflow.slice(
      workflow.indexOf('      - name: Verify deployed provisioning contract'),
      workflow.indexOf('      - name: Smoke candidate revision'),
    );
    expect(deployedContract).toContain('GOLDEN_SNAPSHOTS_ENABLED');
    expect(deployedContract).toContain('GOLDEN_SNAPSHOT_ROLLOUT_PERCENT');
  });

  it('lets durable release registration derive eligibility from the promoted channel', () => {
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).not.toContain('GOLDEN_SNAPSHOT_ELIGIBLE:');
  });

  it('resolves enqueue validation from the platform package and preserves eligibility in both publishers', () => {
    const enqueueScript = readFileSync(join(root, 'scripts/enqueue-golden-snapshot.mjs'), 'utf8');
    const nodePublisher = readFileSync(join(root, 'scripts/publish-release-r2.mjs'), 'utf8');

    expect(enqueueScript).not.toContain("import { z } from 'zod/v4'");
    expect(enqueueScript).toContain('createRequire');
    expect(enqueueScript).toContain('packages/platform/package.json');
    expect(nodePublisher).toContain('resolveReleaseSnapshotEligibility');
  });

  it('defaults only stable eligible while preserving explicit overrides', () => {
    expect(resolveReleaseSnapshotEligibility('stable')).toBe(true);
    for (const channel of ['dev', 'canary', 'beta']) {
      expect(resolveReleaseSnapshotEligibility(channel)).toBe(false);
    }
    expect(resolveReleaseSnapshotEligibility('none')).toBe(false);
    expect(resolveReleaseSnapshotEligibility('preview')).toBe(false);
    expect(resolveReleaseSnapshotEligibility('dev', 'false')).toBe(false);
    expect(resolveReleaseSnapshotEligibility('none', 'true')).toBe(true);
    expect(() => resolveReleaseSnapshotEligibility('dev', 'yes')).toThrow('must be true or false');
  });
});

describe('forward-only stable golden snapshot promotion', () => {
  let db: PlatformDB;
  beforeEach(async () => ({ db } = await createTestPlatformDb()));
  afterEach(async () => destroyTestPlatformDb(db));

  it('atomically registers an eligible stable release and queues its exact snapshot build', async () => {
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };

    await expect(registerHostBundleReleaseWithStableSnapshot(db, {
      version: 'v-stable', gitCommit: '1111111', gitRef: 'main',
      buildTime: '2026-07-01T00:00:00.000Z',
      bundleKey: 'system-bundles/v-stable/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '1'.repeat(64), size: 100, createdAt: '2026-07-01T00:00:00.000Z',
    }, 'stable', {
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000001',
      buildId: '20000000-0000-4000-8000-000000000001',
      now: '2026-07-01T00:01:00.000Z',
    })).resolves.toMatchObject({
      release: { version: 'v-stable', snapshotEligible: true },
      channel: { channel: 'stable', version: 'v-stable' },
    });

    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-stable'])))
      .toEqual({ 'v-stable': 'requested' });
  });

  it('queues an existing release only when it is promoted to stable', async () => {
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    await upsertHostBundleRelease(db, {
      version: 'v-promoted', gitCommit: '2222222', gitRef: 'main', snapshotEligible: false,
      buildTime: '2026-07-02T00:00:00.000Z',
      bundleKey: 'system-bundles/v-promoted/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '2'.repeat(64), size: 100, createdAt: '2026-07-02T00:00:00.000Z',
    });
    await promoteHostBundleChannel(db, 'dev', 'v-promoted', '2026-07-02T00:01:00.000Z');

    await expect(promoteHostBundleChannelWithStableSnapshot(db, 'stable', 'v-promoted', {
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000002',
      buildId: '20000000-0000-4000-8000-000000000002',
      now: '2026-07-02T00:02:00.000Z',
    })).resolves.toMatchObject({
      release: { version: 'v-promoted', snapshotEligible: true },
      channel: { channel: 'stable', version: 'v-promoted' },
    });
    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-promoted'])))
      .toEqual({ 'v-promoted': 'requested' });
  });

  it('quarantines and cleans unfinished work when a newer stable release supersedes it', async () => {
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    const release = (version: string, digit: string, buildTime: string) => ({
      version, gitCommit: digit.repeat(7), gitRef: 'main', buildTime,
      bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, checksumKey: null,
      sha256: digit.repeat(64), size: 100, createdAt: buildTime,
    });
    await registerHostBundleReleaseWithStableSnapshot(db, release(
      'v-old-stable', '3', '2026-07-03T00:00:00.000Z',
    ), 'stable', {
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000003',
      buildId: '20000000-0000-4000-8000-000000000003',
      now: '2026-07-03T00:01:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'building' })
      .where('snapshot_id', '=', '10000000-0000-4000-8000-000000000003').execute();
    await db.executor.updateTable('golden_snapshot_builds').set({
      status: 'running', phase: 'builder_create', provider_builder_id: 42,
      lease_expires_at: '2026-07-03T00:10:00.000Z',
    }).where('build_id', '=', '20000000-0000-4000-8000-000000000003').execute();

    await registerHostBundleReleaseWithStableSnapshot(db, release(
      'v-new-stable', '4', '2026-07-04T00:00:00.000Z',
    ), 'stable', {
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000004',
      buildId: '20000000-0000-4000-8000-000000000004',
      now: '2026-07-04T00:01:00.000Z',
    });

    await expect(db.executor.selectFrom('golden_snapshots').select(['state', 'failure_code'])
      .where('snapshot_id', '=', '10000000-0000-4000-8000-000000000003').executeTakeFirst())
      .resolves.toEqual({ state: 'quarantined', failure_code: 'superseded_stable_release' });
    await expect(db.executor.selectFrom('golden_snapshot_builds').select(['status', 'phase', 'last_error_code'])
      .where('build_id', '=', '20000000-0000-4000-8000-000000000003').executeTakeFirst())
      .resolves.toEqual({ status: 'failed', phase: 'failed', last_error_code: 'superseded_stable_release' });
    await expect(db.executor.selectFrom('golden_snapshot_cleanup').select(['resource_type', 'provider_resource_id'])
      .where('snapshot_id', '=', '10000000-0000-4000-8000-000000000003').execute())
      .resolves.toEqual([{ resource_type: 'builder_server', provider_resource_id: 42 }]);
    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-new-stable'])))
      .toEqual({ 'v-new-stable': 'requested' });
  });

  it('preserves unfinished work when a stable alias has the same immutable bundle digest', async () => {
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    const release = (version: string, buildTime: string) => ({
      version, gitCommit: '5555555', gitRef: 'main', buildTime,
      bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, checksumKey: null,
      sha256: '5'.repeat(64), size: 100, createdAt: buildTime,
    });
    await registerHostBundleReleaseWithStableSnapshot(db, release(
      'v-original-stable', '2026-07-04T00:00:00.000Z',
    ), 'stable', {
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000005',
      buildId: '20000000-0000-4000-8000-000000000005',
      now: '2026-07-04T00:01:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'building' })
      .where('snapshot_id', '=', '10000000-0000-4000-8000-000000000005').execute();
    await db.executor.updateTable('golden_snapshot_builds').set({ status: 'running' })
      .where('build_id', '=', '20000000-0000-4000-8000-000000000005').execute();

    await expect(registerHostBundleReleaseWithStableSnapshot(db, release(
      'v-stable-alias', '2026-07-04T01:00:00.000Z',
    ), 'stable', {
      compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000006',
      buildId: '20000000-0000-4000-8000-000000000006',
      now: '2026-07-04T01:01:00.000Z',
    })).resolves.toMatchObject({
      release: { version: 'v-stable-alias', snapshotEligible: true },
      channel: { channel: 'stable', version: 'v-stable-alias' },
    });

    await expect(db.executor.selectFrom('golden_snapshots').select(['state', 'failure_code'])
      .where('snapshot_id', '=', '10000000-0000-4000-8000-000000000005').executeTakeFirst())
      .resolves.toEqual({ state: 'building', failure_code: null });
    await expect(db.executor.selectFrom('golden_snapshot_builds').select('status')
      .where('build_id', '=', '20000000-0000-4000-8000-000000000005').executeTakeFirst())
      .resolves.toEqual({ status: 'running' });
    await expect(db.executor.selectFrom('golden_snapshot_cleanup').select('cleanup_id')
      .where('snapshot_id', '=', '10000000-0000-4000-8000-000000000005').execute())
      .resolves.toEqual([]);
    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-stable-alias'])))
      .toEqual({ 'v-stable-alias': 'building' });
  });

  it('does not scan or backfill previously registered eligible releases', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v-historical', gitCommit: '4444444', gitRef: 'main', snapshotEligible: true,
      buildTime: '2026-07-04T00:00:00.000Z',
      bundleKey: 'system-bundles/v-historical/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '4'.repeat(64), size: 100, createdAt: '2026-07-04T00:00:00.000Z',
    });
    await promoteHostBundleChannel(db, 'stable', 'v-historical', '2026-07-04T00:01:00.000Z');

    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-historical'])))
      .toEqual({ 'v-historical': 'not_requested' });
  });

  it('persists an explicit stable opt-out and supersedes unfinished older work without enqueueing', async () => {
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    await registerHostBundleReleaseWithStableSnapshot(db, {
      version: 'v-old-opt-out', gitCommit: '8888888', gitRef: 'main',
      buildTime: '2026-07-05T00:00:00.000Z',
      bundleKey: 'system-bundles/v-old-opt-out/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '8'.repeat(64), size: 100, createdAt: '2026-07-05T00:00:00.000Z',
    }, 'stable', {
      compatibility, snapshotId: '10000000-0000-4000-8000-000000000088',
      buildId: '20000000-0000-4000-8000-000000000088', now: '2026-07-05T00:01:00.000Z',
    });
    await db.executor.updateTable('golden_snapshot_builds').set({ status: 'running' })
      .where('build_id', '=', '20000000-0000-4000-8000-000000000088').execute();

    const optedOut = await registerHostBundleReleaseWithStableSnapshot(db, {
      version: 'v-stable-opt-out', gitCommit: '9999999', gitRef: 'main', snapshotEligible: false,
      buildTime: '2026-07-06T00:00:00.000Z',
      bundleKey: 'system-bundles/v-stable-opt-out/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '9'.repeat(64), size: 100, createdAt: '2026-07-06T00:00:00.000Z',
    }, 'stable', {
      compatibility, snapshotId: '10000000-0000-4000-8000-000000000089',
      buildId: '20000000-0000-4000-8000-000000000089', now: '2026-07-06T00:01:00.000Z',
    });

    expect(optedOut.release.snapshotEligible).toBe(false);
    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-stable-opt-out'])))
      .toEqual({ 'v-stable-opt-out': 'not_requested' });
    await expect(db.executor.selectFrom('golden_snapshot_builds').select('status')
      .where('build_id', '=', '20000000-0000-4000-8000-000000000088').executeTakeFirst())
      .resolves.toEqual({ status: 'failed' });
  });

  it('cancels the current release build when that stable release opts out', async () => {
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    await registerHostBundleReleaseWithStableSnapshot(db, {
      version: 'v-current-opt-out', gitCommit: 'aaaaaaa', gitRef: 'main',
      buildTime: '2026-07-07T00:00:00.000Z',
      bundleKey: 'system-bundles/v-current-opt-out/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: 'a'.repeat(64), size: 100, createdAt: '2026-07-07T00:00:00.000Z',
    }, 'stable', {
      compatibility, snapshotId: '10000000-0000-4000-8000-000000000090',
      buildId: '20000000-0000-4000-8000-000000000090', now: '2026-07-07T00:01:00.000Z',
    });

    await promoteHostBundleChannelWithStableSnapshot(db, 'stable', 'v-current-opt-out', {
      snapshotEligible: false, now: '2026-07-07T00:02:00.000Z',
    });

    await expect(db.executor.selectFrom('golden_snapshot_builds').select('status')
      .where('build_id', '=', '20000000-0000-4000-8000-000000000090').executeTakeFirst())
      .resolves.toEqual({ status: 'failed' });
    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-current-opt-out'])))
      .toEqual({ 'v-current-opt-out': 'failed' });
  });

  it('rolls back the stable pointer and eligibility when enqueue fails', async () => {
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'revoked-generation',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    await upsertHostBundleRelease(db, {
      version: 'v-existing-stable', gitCommit: 'bbbbbbb', gitRef: 'main', snapshotEligible: false,
      buildTime: '2026-07-08T00:00:00.000Z',
      bundleKey: 'system-bundles/v-existing-stable/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: 'b'.repeat(64), size: 100, createdAt: '2026-07-08T00:00:00.000Z',
    });
    await upsertHostBundleRelease(db, {
      version: 'v-revoked-target', gitCommit: 'ccccccc', gitRef: 'main', snapshotEligible: false,
      buildTime: '2026-07-09T00:00:00.000Z',
      bundleKey: 'system-bundles/v-revoked-target/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: 'c'.repeat(64), size: 100, createdAt: '2026-07-09T00:00:00.000Z',
    });
    await promoteHostBundleChannel(db, 'stable', 'v-existing-stable', '2026-07-08T00:01:00.000Z');
    await db.executor.insertInto('golden_snapshot_revoked_base_generations').values({
      base_generation: compatibility.baseGeneration,
      reason: 'test_revocation',
      revoked_at: '2026-07-08T00:02:00.000Z',
      updated_at: '2026-07-08T00:02:00.000Z',
    }).execute();

    await expect(promoteHostBundleChannelWithStableSnapshot(db, 'stable', 'v-revoked-target', {
      compatibility, snapshotId: '10000000-0000-4000-8000-000000000091',
      buildId: '20000000-0000-4000-8000-000000000091', now: '2026-07-09T00:01:00.000Z',
    })).rejects.toThrow('Base generation is revoked');

    await expect(getHostBundleChannel(db, 'stable'))
      .resolves.toMatchObject({ version: 'v-existing-stable' });
    await expect(db.executor.selectFrom('host_bundle_releases').select('snapshot_eligible')
      .where('version', '=', 'v-revoked-target').executeTakeFirst())
      .resolves.toEqual({ snapshot_eligible: false });
  });

  it('reports status only for the active provisioning compatibility', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v-active-compatibility', gitCommit: '5555555', gitRef: 'main', snapshotEligible: true,
      buildTime: '2026-07-05T00:00:00.000Z',
      bundleKey: 'system-bundles/v-active-compatibility/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '5'.repeat(64), size: 100, createdAt: '2026-07-05T00:00:00.000Z',
    });
    const activeCompatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v2',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v-active-compatibility',
      compatibility: { ...activeCompatibility, baseGeneration: 'ubuntu-24.04-v1' },
      snapshotId: '10000000-0000-4000-8000-000000000097',
      buildId: '20000000-0000-4000-8000-000000000097', now: '2026-07-05T00:01:00.000Z',
    });
    await db.executor.updateTable('golden_snapshots').set({ state: 'ready' })
      .where('snapshot_id', '=', '10000000-0000-4000-8000-000000000097').execute();
    await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v-active-compatibility', compatibility: activeCompatibility,
      snapshotId: '10000000-0000-4000-8000-000000000098',
      buildId: '20000000-0000-4000-8000-000000000098', now: '2026-07-05T00:02:00.000Z',
    });

    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(
      db, ['v-active-compatibility'], activeCompatibility,
    ))).toEqual({ 'v-active-compatibility': 'requested' });
  });

});
