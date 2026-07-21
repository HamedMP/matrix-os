import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createApp } from '../../packages/platform/src/main.js';
import type { CustomerVpsObjectStore } from '../../packages/platform/src/customer-vps-r2.js';
import {
  getHostBundleRelease,
  listHostBundleReleases,
  promoteHostBundleChannel,
  type PlatformDB,
  upsertHostBundleRelease,
} from '../../packages/platform/src/db.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';
import { enqueueGoldenSnapshotBuild } from '../../packages/platform/src/golden-snapshot-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('platform host bundle route', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  const orchestrator = {
    provision: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    upgrade: vi.fn(),
    rollingRestart: vi.fn(),
    getInfo: vi.fn(),
    getImage: vi.fn(),
    listAll: vi.fn().mockReturnValue([]),
    syncStates: vi.fn(),
  } as unknown as Orchestrator;

  async function seedRelease(version = 'v2026.05.12-1') {
    return upsertHostBundleRelease(db, {
      version,
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`,
      checksumKey: `system-bundles/${version}/matrix-host-bundle.tar.gz.sha256`,
      sha256: 'a'.repeat(64),
      size: 1234,
    });
  }

  it('serves host bundle checksums from platform DB without admin auth', async () => {
    await seedRelease();
    const getObject = vi.fn();
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz.sha256');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`${'a'.repeat(64)}  matrix-host-bundle.tar.gz\n`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(getObject).not.toHaveBeenCalled();
  });

  it('redirects host bundle archives to signed object-store URLs', async () => {
    await seedRelease();
    const getPresignedGetUrl = vi.fn().mockResolvedValue('https://r2.example/signed-host-bundle');
    const getObject = vi.fn();
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject,
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://r2.example/signed-host-bundle');
    expect(getPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz',
      3600,
    );
    expect(getObject).not.toHaveBeenCalled();
  });

  it('uses dedicated host bundle object storage when configured', async () => {
    await seedRelease();
    const syncGetPresignedGetUrl = vi.fn().mockResolvedValue('https://sync.example/wrong-bucket');
    const bundleGetPresignedGetUrl = vi.fn().mockResolvedValue('https://bundles.example/signed-host-bundle');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: syncGetPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
      hostBundleObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: bundleGetPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://bundles.example/signed-host-bundle');
    expect(bundleGetPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz',
      3600,
    );
    expect(syncGetPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('does not fall back to sync storage for customer VPS host bundle archives', async () => {
    await seedRelease();
    const syncGetPresignedGetUrl = vi.fn().mockResolvedValue('https://sync.example/wrong-bucket');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: syncGetPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
      env: {
        CUSTOMER_VPS_ENABLED: 'true',
      },
    });

    const res = await app.request('/system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz');

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Host bundle storage unavailable' });
    expect(syncGetPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('returns JSON 502 when release metadata cannot mint a signed URL', async () => {
    await seedRelease();
    const getPresignedGetUrl = vi.fn().mockRejectedValue(new Error('r2 unavailable'));
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/v2026.05.12-1/release.json');

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: 'Host bundle unavailable' });
    expect(getPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz',
      3600,
    );
  });

  it('rejects invalid host bundle keys', async () => {
    const getObject = vi.fn();
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/matrix-os-host-dev/evil.tgz');

    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('serves channel manifests from platform DB release metadata', async () => {
    await seedRelease();
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.12-1');
    const getObject = vi.fn();
    const getPresignedGetUrl = vi.fn().mockResolvedValue('https://r2.example/signed-host-bundle');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject,
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/channels/stable.json');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({
      version: 'v2026.05.12-1',
      channel: 'stable',
      gitCommit: 'c1598218',
      sha256: 'a'.repeat(64),
      url: 'https://r2.example/signed-host-bundle',
    });
    expect(getObject).not.toHaveBeenCalled();
    expect(getPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz',
      3600,
    );
  });

  it('serves a channel manifest with unavailable status when snapshot lookup fails', async () => {
    await seedRelease();
    await db.executor.updateTable('host_bundle_releases').set({ snapshot_eligible: true })
      .where('version', '=', 'v2026.05.12-1').execute();
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.12-1');
    await db.executor.schema.dropTable('golden_snapshots').cascade().execute();
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: vi.fn().mockResolvedValue('https://r2.example/signed-host-bundle'),
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const response = await app.request('/system-bundles/channels/stable.json');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 'v2026.05.12-1',
      channel: 'stable',
      snapshotStatus: 'unavailable',
    });
  });

  it('uses dedicated host bundle object storage for channel manifests', async () => {
    await seedRelease();
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.12-1');
    const syncGetPresignedGetUrl = vi.fn().mockResolvedValue('https://sync.example/wrong-bucket');
    const bundleGetPresignedGetUrl = vi.fn().mockResolvedValue('https://bundles.example/stable-host-bundle');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: syncGetPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
      hostBundleObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: bundleGetPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/channels/stable.json');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      version: 'v2026.05.12-1',
      channel: 'stable',
      url: 'https://bundles.example/stable-host-bundle',
    });
    expect(bundleGetPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz',
      3600,
    );
    expect(syncGetPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('uses dedicated host bundle object storage for dev channel manifests in customer VPS mode', async () => {
    await seedRelease();
    await promoteHostBundleChannel(db, 'dev', 'v2026.05.12-1');
    const syncGetPresignedGetUrl = vi.fn().mockResolvedValue('https://sync.example/wrong-bucket');
    const bundleGetPresignedGetUrl = vi.fn().mockResolvedValue('https://bundles.example/dev-host-bundle');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: syncGetPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
      hostBundleObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: bundleGetPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
      env: {
        CUSTOMER_VPS_ENABLED: 'true',
      },
    });

    const res = await app.request('/system-bundles/channels/dev.json');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      version: 'v2026.05.12-1',
      channel: 'dev',
      url: 'https://bundles.example/dev-host-bundle',
    });
    expect(bundleGetPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz',
      3600,
    );
    expect(syncGetPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('serializes the requested channel for promoted channel aliases', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.12-7',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-7',
      buildTime: '2026-05-12T04:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-7/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-7/matrix-host-bundle.tar.gz.sha256',
      sha256: 'e'.repeat(64),
      size: 7890,
      channel: 'canary',
    });
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.12-7');
    const getPresignedGetUrl = vi.fn().mockResolvedValue('https://r2.example/promoted-host-bundle');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const channelManifestRes = await app.request('/system-bundles/channels/stable.json');
    expect(channelManifestRes.status).toBe(200);
    await expect(channelManifestRes.json()).resolves.toMatchObject({
      version: 'v2026.05.12-7',
      channel: 'stable',
    });

    const aliasReleaseRes = await app.request('/system-bundles/stable/release.json');
    expect(aliasReleaseRes.status).toBe(200);
    await expect(aliasReleaseRes.json()).resolves.toMatchObject({
      version: 'v2026.05.12-7',
      channel: 'stable',
    });

    const immutableReleaseRes = await app.request('/system-bundles/releases/v2026.05.12-7.json');
    expect(immutableReleaseRes.status).toBe(200);
    await expect(immutableReleaseRes.json()).resolves.toMatchObject({
      version: 'v2026.05.12-7',
      channel: 'canary',
    });
  });

  it('resolves channel aliases to DB releases for cloud-init bundle downloads', async () => {
    await seedRelease();
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.12-1');
    const getPresignedGetUrl = vi.fn().mockResolvedValue('https://r2.example/stable-host-bundle');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/stable/matrix-host-bundle.tar.gz');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://r2.example/stable-host-bundle');
    expect(getPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-1/matrix-host-bundle.tar.gz',
      3600,
    );
  });

  it('serves channel alias checksums with mutable cache headers', async () => {
    await seedRelease();
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.12-1');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/stable/matrix-host-bundle.tar.gz.sha256');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`${'a'.repeat(64)}  matrix-host-bundle.tar.gz\n`);
    expect(res.headers.get('cache-control')).toBe('private, max-age=30');
    expect(res.headers.get('cdn-cache-control')).toBe('private, max-age=30');
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('private, max-age=30');
  });

  it('redirects incremental manifests to signed object-store URLs', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.12-8',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-8',
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-8/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-8/matrix-host-bundle.tar.gz.sha256',
      incrementalManifestKey: 'system-bundles/v2026.05.12-8/incremental-manifest.json',
      incrementalManifestSha256: 'c'.repeat(64),
      sha256: 'a'.repeat(64),
      size: 1234,
    });
    const getPresignedGetUrl = vi.fn().mockResolvedValue('https://r2.example/signed-incremental-manifest');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/v2026.05.12-8/incremental-manifest.json');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://r2.example/signed-incremental-manifest');
    expect(getPresignedGetUrl).toHaveBeenCalledWith(
      'system-bundles/v2026.05.12-8/incremental-manifest.json',
      3600,
    );
  });

  it('redirects incremental file objects to signed object-store URLs', async () => {
    const sha256 = 'd'.repeat(64);
    const getPresignedGetUrl = vi.fn().mockResolvedValue('https://r2.example/signed-incremental-object');
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request(`/system-bundles/objects/sha256/${sha256}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://r2.example/signed-incremental-object');
    expect(getPresignedGetUrl).toHaveBeenCalledWith(
      `system-bundles/objects/sha256/${sha256}`,
      3600,
    );
  });

  it('registers release metadata in platform DB and promotes channels', async () => {
    const app = createApp({
      db,
      orchestrator,
      platformSecret: 'secret',
      customerVpsObjectStore: {
        getObject: vi.fn(),
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/releases', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: 'v2026.05.12-2',
        gitCommit: 'c15982181234567890',
        gitRef: 'refs/tags/v2026.05.12-2',
        buildTime: '2026-05-12T01:00:00.000Z',
        bundleKey: 'system-bundles/v2026.05.12-2/matrix-host-bundle.tar.gz',
        checksumKey: 'system-bundles/v2026.05.12-2/matrix-host-bundle.tar.gz.sha256',
        incrementalManifestKey: 'system-bundles/v2026.05.12-2/incremental-manifest.json',
        incrementalManifestSha256: 'c'.repeat(64),
        sha256: 'b'.repeat(64),
        size: 5678,
        channel: 'canary',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      release: {
        version: 'v2026.05.12-2',
        channel: 'canary',
        gitCommit: 'c15982181234567890',
        incrementalManifestKey: 'system-bundles/v2026.05.12-2/incremental-manifest.json',
        incrementalManifestSha256: 'c'.repeat(64),
      },
      channel: {
        channel: 'canary',
        version: 'v2026.05.12-2',
      },
    });

    const releasesRes = await app.request('/system-bundles/releases');
    await expect(releasesRes.json()).resolves.toMatchObject({
      releases: [
        {
          version: 'v2026.05.12-2',
          channel: 'canary',
          bundleKey: 'system-bundles/v2026.05.12-2/matrix-host-bundle.tar.gz',
        },
      ],
    });

    const channelReleasesRes = await app.request('/system-bundles/releases?channel=canary');
    await expect(channelReleasesRes.json()).resolves.toMatchObject({
      releases: [{ version: 'v2026.05.12-2', channel: 'canary' }],
    });

    const stableReleasesRes = await app.request('/system-bundles/releases?channel=stable');
    await expect(stableReleasesRes.json()).resolves.toMatchObject({ releases: [] });

    const emptyChannelRes = await app.request('/system-bundles/releases?channel=');
    expect(emptyChannelRes.status).toBe(400);

    const promoteRes = await app.request('/system-bundles/channels/stable', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ version: 'v2026.05.12-2' }),
    });
    expect(promoteRes.status).toBe(200);

    const promotedStableRes = await app.request('/system-bundles/releases?channel=stable');
    await expect(promotedStableRes.json()).resolves.toMatchObject({
      releases: [{ version: 'v2026.05.12-2', channel: 'canary' }],
    });

    const canaryAfterPromotionRes = await app.request('/system-bundles/releases?channel=canary');
    await expect(canaryAfterPromotionRes.json()).resolves.toMatchObject({
      releases: [{ version: 'v2026.05.12-2', channel: 'canary' }],
    });

    const reRegisterRes = await app.request('/system-bundles/releases', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: 'v2026.05.12-2',
        gitCommit: 'c15982181234567890',
        gitRef: 'refs/tags/v2026.05.12-2',
        buildTime: '2026-05-12T01:00:00.000Z',
        bundleKey: 'system-bundles/v2026.05.12-2/matrix-host-bundle.tar.gz',
        checksumKey: 'system-bundles/v2026.05.12-2/matrix-host-bundle.tar.gz.sha256',
        incrementalManifestKey: 'system-bundles/v2026.05.12-2/incremental-manifest.json',
        incrementalManifestSha256: 'c'.repeat(64),
        sha256: 'b'.repeat(64),
        size: 5678,
        channel: 'stable',
      }),
    });
    expect(reRegisterRes.status).toBe(200);

    const canaryAfterReRegisterRes = await app.request('/system-bundles/releases?channel=canary');
    await expect(canaryAfterReRegisterRes.json()).resolves.toMatchObject({
      releases: [{ version: 'v2026.05.12-2', channel: 'canary' }],
    });
  });

  it('rejects snapshot eligibility for a version outside the snapshot identity schema', async () => {
    const app = createApp({
      db, orchestrator, platformSecret: 'secret',
      customerVpsObjectStore: { getObject: vi.fn(), putObject: vi.fn() } as unknown as CustomerVpsObjectStore,
    });
    const response = await app.request('/system-bundles/releases', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: '.rollback', gitCommit: 'c1598218', gitRef: 'main', snapshotEligible: true,
        buildTime: '2026-07-19T00:00:00.000Z',
        bundleKey: 'system-bundles/.rollback/matrix-host-bundle.tar.gz', checksumKey: null,
        sha256: 'b'.repeat(64), size: 1234,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid request' });
  });

  it('exposes only coarse snapshot lifecycle status with immutable release metadata', async () => {
    await seedRelease();
    await enqueueGoldenSnapshotBuild(db, {
      bundleVersion: 'v2026.05.12-1',
      compatibility: {
        provider: 'hetzner',
        architecture: 'x86',
        region: 'eu-central',
        baseImage: 'ubuntu-24.04',
        baseGeneration: 'ubuntu-24.04-v1',
        bootMode: 'bios',
        activationAbi: 'host-v1',
        minimumDiskGb: 40,
      },
      snapshotId: '10000000-0000-4000-8000-000000000099',
      buildId: '20000000-0000-4000-8000-000000000099',
      now: '2026-07-19T00:00:00.000Z',
    });
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: vi.fn().mockResolvedValue('https://r2.example/signed-host-bundle'),
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const response = await app.request('/system-bundles/releases/v2026.05.12-1.json');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 'v2026.05.12-1',
      sha256: 'a'.repeat(64),
      snapshotStatus: 'requested',
    });
  });

  it('returns not_requested snapshot status for a valid release version that is not snapshot-eligible', async () => {
    await upsertHostBundleRelease(db, {
      version: '.rollback', gitCommit: 'c1598218', gitRef: 'main',
      buildTime: '2026-07-19T00:00:00.000Z',
      bundleKey: 'system-bundles/.rollback/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: 'b'.repeat(64), size: 1234, snapshotEligible: false,
    });
    const app = createApp({
      db,
      orchestrator,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: vi.fn().mockResolvedValue('https://r2.example/signed-host-bundle'),
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const response = await app.request('/system-bundles/releases/.rollback.json');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: '.rollback', snapshotStatus: 'not_requested',
    });
  });

  it('keeps release publication successful when snapshot status is unavailable', async () => {
    await db.executor.schema.dropTable('golden_snapshots').cascade().execute();
    const app = createApp({
      db, orchestrator, platformSecret: 'secret',
      customerVpsObjectStore: { getObject: vi.fn(), putObject: vi.fn() } as unknown as CustomerVpsObjectStore,
    });

    const response = await app.request('/system-bundles/releases', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'v2026.07.21-status-isolation', gitCommit: 'c1598218', gitRef: 'main',
        snapshotEligible: true, buildTime: '2026-07-21T00:00:00.000Z',
        bundleKey: 'system-bundles/v2026.07.21-status-isolation/matrix-host-bundle.tar.gz',
        checksumKey: null, sha256: 'c'.repeat(64), size: 1234,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      release: { version: 'v2026.07.21-status-isolation', snapshotStatus: 'unavailable' },
    });
    await expect(getHostBundleRelease(db, 'v2026.07.21-status-isolation')).resolves.toBeDefined();
  });

  it('rolls back release registration when its requested channel promotion fails', async () => {
    await sql`
      CREATE OR REPLACE FUNCTION reject_host_bundle_channel_promotion() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected channel promotion failure';
      END;
      $$ LANGUAGE plpgsql
    `.execute(db.executor);
    await sql`
      CREATE TRIGGER reject_host_bundle_channel_promotion
      BEFORE INSERT OR UPDATE ON host_bundle_channels
      FOR EACH ROW EXECUTE FUNCTION reject_host_bundle_channel_promotion()
    `.execute(db.executor);
    const app = createApp({
      db, orchestrator, platformSecret: 'secret',
      customerVpsObjectStore: { getObject: vi.fn(), putObject: vi.fn() } as unknown as CustomerVpsObjectStore,
    });

    const response = await app.request('/system-bundles/releases', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'v2026.07.21-atomic', gitCommit: 'c1598218', gitRef: 'main',
        snapshotEligible: true, buildTime: '2026-07-21T00:00:00.000Z',
        bundleKey: 'system-bundles/v2026.07.21-atomic/matrix-host-bundle.tar.gz',
        checksumKey: null, sha256: 'd'.repeat(64), size: 1234, channel: 'dev',
      }),
    });

    expect(response.status).toBe(502);
    await expect(getHostBundleRelease(db, 'v2026.07.21-atomic')).resolves.toBeUndefined();
  });

  it('only adds release channel history when channel promotion succeeds', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.12-6',
      gitCommit: 'c15982181234567890',
      gitRef: 'refs/tags/v2026.05.12-6',
      buildTime: '2026-05-12T03:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-6/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-6/matrix-host-bundle.tar.gz.sha256',
      sha256: 'd'.repeat(64),
      size: 4321,
      channel: 'dev',
    });

    await expect(listHostBundleReleases(db, 10, 'dev')).resolves.toEqual([]);

    await promoteHostBundleChannel(db, 'dev', 'v2026.05.12-6');

    await expect(listHostBundleReleases(db, 10, 'dev')).resolves.toMatchObject([
      { version: 'v2026.05.12-6', channel: 'dev' },
    ]);
  });

  it('rejects release re-registration when immutable artifact fields differ', async () => {
    await seedRelease('v2026.05.12-3');

    await expect(upsertHostBundleRelease(db, {
      version: 'v2026.05.12-3',
      gitCommit: 'updatedsha',
      gitRef: 'refs/tags/v2026.05.12-3',
      buildTime: '2026-05-12T02:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-3/replaced.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-3/replaced.tar.gz.sha256',
      sha256: 'c'.repeat(64),
      size: 9999,
      severity: 'security',
      updateType: 'auto',
      changelog: 'metadata only',
    })).rejects.toThrow('Host bundle release already exists with different artifact fields');

    await expect(getHostBundleRelease(db, 'v2026.05.12-3')).resolves.toMatchObject({
      bundleKey: 'system-bundles/v2026.05.12-3/matrix-host-bundle.tar.gz',
      sha256: 'a'.repeat(64),
      size: 1234,
    });
  });

  it('allows release metadata re-registration when immutable artifact fields match', async () => {
    await seedRelease('v2026.05.12-4');

    const updated = await upsertHostBundleRelease(db, {
      version: 'v2026.05.12-4',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-4/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-4/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1234,
      severity: 'security',
      updateType: 'auto',
      changelog: 'metadata only',
    });

    expect(updated).toMatchObject({
      version: 'v2026.05.12-4',
      gitCommit: 'c1598218',
      severity: 'security',
      updateType: 'auto',
      changelog: 'metadata only',
      bundleKey: 'system-bundles/v2026.05.12-4/matrix-host-bundle.tar.gz',
      sha256: 'a'.repeat(64),
      size: 1234,
    });
  });

  it('preserves snapshot eligibility when metadata re-registration omits it', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.12-snapshot',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      snapshotEligible: true,
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-snapshot/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-snapshot/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1234,
    });

    await expect(upsertHostBundleRelease(db, {
      version: 'v2026.05.12-snapshot',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-snapshot/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-snapshot/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1234,
      severity: 'security',
    })).resolves.toMatchObject({ snapshotEligible: true, severity: 'security' });
  });

  it('preserves snapshot eligibility when metadata re-registration explicitly sends false', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.12-snapshot-explicit-false',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      snapshotEligible: true,
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-snapshot-explicit-false/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-snapshot-explicit-false/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1234,
    });

    await expect(upsertHostBundleRelease(db, {
      version: 'v2026.05.12-snapshot-explicit-false',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      snapshotEligible: false,
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-snapshot-explicit-false/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-snapshot-explicit-false/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1234,
      severity: 'security',
    })).resolves.toMatchObject({ snapshotEligible: true, severity: 'security' });
  });

  it('atomically promotes an identical release to snapshot eligible on trusted re-publication', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.12-snapshot-promoted',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      snapshotEligible: false,
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-snapshot-promoted/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-snapshot-promoted/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1234,
    });

    await expect(upsertHostBundleRelease(db, {
      version: 'v2026.05.12-snapshot-promoted',
      gitCommit: 'c1598218',
      gitRef: 'refs/tags/v2026.05.12-1',
      snapshotEligible: true,
      buildTime: '2026-05-12T00:00:00.000Z',
      bundleKey: 'system-bundles/v2026.05.12-snapshot-promoted/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.12-snapshot-promoted/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1234,
      severity: 'security',
    })).resolves.toMatchObject({ snapshotEligible: true, severity: 'security' });
  });

  it('returns 409 when release registration would replace an immutable artifact', async () => {
    await seedRelease('v2026.05.12-5');
    const app = createApp({
      db,
      orchestrator,
      platformSecret: 'secret',
      customerVpsObjectStore: {
        getObject: vi.fn(),
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/releases', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: 'v2026.05.12-5',
        gitCommit: 'updatedsha',
        gitRef: 'refs/tags/v2026.05.12-5',
        buildTime: '2026-05-12T02:00:00.000Z',
        bundleKey: 'system-bundles/v2026.05.12-5/matrix-host-bundle.tar.gz',
        checksumKey: 'system-bundles/v2026.05.12-5/matrix-host-bundle.tar.gz.sha256',
        sha256: 'c'.repeat(64),
        size: 9999,
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Release already exists with different artifact metadata',
    });
  });
});
