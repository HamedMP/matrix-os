import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  enqueueGoldenSnapshotBuild,
  getGoldenSnapshotCoarseStatuses,
  reconcileMissingGoldenSnapshotBuilds,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import {
  enqueueGoldenSnapshot,
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

  it('keeps snapshot enqueue failure isolated from existing fleet deployment', () => {
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');
    const enqueueJob = workflow.slice(
      workflow.indexOf('\n  enqueue-golden-snapshot:'),
      workflow.indexOf('\n  deploy:'),
    );
    const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));

    expect(enqueueJob).toContain('needs: [dev-bundle-gate, build, publish]');
    expect(enqueueJob).toContain('continue-on-error: true');
    expect(enqueueJob).toContain("github.event_name == 'push'");
    expect(enqueueJob).toContain("(github.event_name == 'workflow_dispatch' && inputs.channel != '')");
    expect(enqueueJob).toContain("github.ref_name == 'main'");
    expect(enqueueJob).toContain("github.ref_type == 'tag'");
    expect(enqueueJob).toContain('PUBLISH_CHANNEL: ${{ needs.build.outputs.channel }}');
    expect(enqueueJob).toContain('PUBLISH_VERSION: ${{ needs.build.outputs.version }}');
    expect(enqueueJob).toContain('scripts/enqueue-golden-snapshot.mjs --version "$PUBLISH_VERSION"');
    expect(enqueueJob).not.toContain('--version "${{ needs.build.outputs.version }}"');
    expect(deployJob).toContain('needs: [dev-bundle-gate, build, publish]');
    expect(deployJob).not.toContain('enqueue-golden-snapshot');
  });

  it('uses the same manual-channel eligibility rule for durable release registration', () => {
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain(
      "GOLDEN_SNAPSHOT_ELIGIBLE: ${{ (github.event_name == 'push' && ((github.ref_type == 'branch' && github.ref_name == 'main') || github.ref_type == 'tag')) || (github.event_name == 'workflow_dispatch' && inputs.channel != '') }}",
    );
  });

  it('resolves enqueue validation from the platform package and preserves eligibility in both publishers', () => {
    const enqueueScript = readFileSync(join(root, 'scripts/enqueue-golden-snapshot.mjs'), 'utf8');
    const nodePublisher = readFileSync(join(root, 'scripts/publish-release-r2.mjs'), 'utf8');

    expect(enqueueScript).not.toContain("import { z } from 'zod/v4'");
    expect(enqueueScript).toContain('createRequire');
    expect(enqueueScript).toContain('packages/platform/package.json');
    expect(nodePublisher).toContain('resolveReleaseSnapshotEligibility');
  });

  it('defaults customer channels eligible while keeping preview and explicit opt-out ineligible', () => {
    for (const channel of ['dev', 'canary', 'beta', 'stable']) {
      expect(resolveReleaseSnapshotEligibility(channel)).toBe(true);
    }
    expect(resolveReleaseSnapshotEligibility('none')).toBe(false);
    expect(resolveReleaseSnapshotEligibility('preview')).toBe(false);
    expect(resolveReleaseSnapshotEligibility('dev', 'false')).toBe(false);
    expect(resolveReleaseSnapshotEligibility('none', 'true')).toBe(true);
    expect(() => resolveReleaseSnapshotEligibility('dev', 'yes')).toThrow('must be true or false');
  });
});

describe('durable golden snapshot release reconciliation', () => {
  let db: PlatformDB;
  beforeEach(async () => ({ db } = await createTestPlatformDb()));
  afterEach(async () => destroyTestPlatformDb(db));

  it('enqueues eligible durable releases missing a candidate and batches coarse status reads', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v1', gitCommit: '1111111', gitRef: 'main', snapshotEligible: true, buildTime: '2026-07-01T00:00:00.000Z',
      bundleKey: 'system-bundles/v1/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '1'.repeat(64), size: 100, createdAt: '2026-07-01T00:00:00.000Z',
    });
    await upsertHostBundleRelease(db, {
      version: 'preview-1', gitCommit: '2222222', gitRef: 'preview-1', buildTime: '2026-07-02T00:00:00.000Z',
      bundleKey: 'system-bundles/preview-1/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '2'.repeat(64), size: 100, createdAt: '2026-07-02T00:00:00.000Z',
    });
    await upsertHostBundleRelease(db, {
      version: 'manual-main', gitCommit: '3333333', gitRef: 'main', snapshotEligible: false,
      buildTime: '2026-07-02T01:00:00.000Z', bundleKey: 'system-bundles/manual-main/matrix-host-bundle.tar.gz',
      checksumKey: null, sha256: '3'.repeat(64), size: 100, createdAt: '2026-07-02T01:00:00.000Z',
    });
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };

    await expect(reconcileMissingGoldenSnapshotBuilds(db, {
      compatibility, now: '2026-07-03T00:00:00.000Z', limit: 25,
    })).resolves.toEqual({ enqueued: 1 });
    await expect(reconcileMissingGoldenSnapshotBuilds(db, {
      compatibility, now: '2026-07-03T00:01:00.000Z', limit: 25,
    })).resolves.toEqual({ enqueued: 0 });
    const statuses = await getGoldenSnapshotCoarseStatuses(db, ['v1', 'preview-1', 'manual-main', 'missing']);
    expect(Object.fromEntries(statuses)).toEqual({
      v1: 'requested', 'preview-1': 'not_requested', 'manual-main': 'not_requested', missing: 'not_requested',
    });
  });

  it('never lets test-mode snapshots satisfy production reconciliation or public status', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v-test-isolation', gitCommit: '4444444', gitRef: 'main', snapshotEligible: true,
      buildTime: '2026-07-04T00:00:00.000Z',
      bundleKey: 'system-bundles/v-test-isolation/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '4'.repeat(64), size: 100, createdAt: '2026-07-04T00:00:00.000Z',
    });
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };
    await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v-test-isolation', compatibility, testMode: true,
      snapshotId: '10000000-0000-4000-8000-000000000099',
      buildId: '20000000-0000-4000-8000-000000000099',
      now: '2026-07-04T00:01:00.000Z',
    });

    expect(Object.fromEntries(await getGoldenSnapshotCoarseStatuses(db, ['v-test-isolation'])))
      .toEqual({ 'v-test-isolation': 'not_requested' });
    await expect(reconcileMissingGoldenSnapshotBuilds(db, {
      compatibility, now: '2026-07-04T00:02:00.000Z', limit: 25,
    })).resolves.toEqual({ enqueued: 1 });
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

  it('prioritizes the newest missing eligible release within each bounded reconciliation batch', async () => {
    for (const [version, day, sha] of [['v-backlog-old', '01', '6'], ['v-backlog-new', '02', '7']] as const) {
      await upsertHostBundleRelease(db, {
        version, gitCommit: sha.repeat(7), gitRef: 'main', snapshotEligible: true,
        buildTime: `2026-07-${day}T00:00:00.000Z`,
        bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, checksumKey: null,
        sha256: sha.repeat(64), size: 100, createdAt: `2026-07-${day}T00:00:00.000Z`,
      });
    }
    const compatibility = {
      provider: 'hetzner' as const, architecture: 'x86' as const, region: 'eu-central',
      baseImage: 'ubuntu-24.04', baseGeneration: 'ubuntu-24.04-v1',
      bootMode: 'bios' as const, activationAbi: 'host-v1', minimumDiskGb: 40,
    };

    await expect(reconcileMissingGoldenSnapshotBuilds(db, {
      compatibility, now: '2026-07-03T00:00:00.000Z', limit: 1,
    })).resolves.toEqual({ enqueued: 1 });
    await expect(db.executor.selectFrom('golden_snapshots').select('bundle_version').execute())
      .resolves.toEqual([{ bundle_version: 'v-backlog-new' }]);
  });
});
