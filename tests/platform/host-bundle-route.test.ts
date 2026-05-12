import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import type { CustomerVpsObjectStore } from '../../packages/platform/src/customer-vps-r2.js';
import {
  promoteHostBundleChannel,
  type PlatformDB,
  upsertHostBundleRelease,
} from '../../packages/platform/src/db.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';
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
        sha256: 'b'.repeat(64),
        size: 5678,
        channel: 'canary',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      release: {
        version: 'v2026.05.12-2',
        gitCommit: 'c15982181234567890',
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
          bundleKey: 'system-bundles/v2026.05.12-2/matrix-host-bundle.tar.gz',
        },
      ],
    });
  });
});
