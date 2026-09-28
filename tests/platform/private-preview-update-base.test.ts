import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createApp } from '../../packages/platform/src/main.js';
import type { CustomerVpsObjectStore } from '../../packages/platform/src/customer-vps-r2.js';
import {
  getLatestHostBundleReleaseForPr,
  insertUserMachine,
  type NewUserMachine,
  type PlatformDB,
  upsertHostBundleRelease,
} from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const secret = 'platform-secret-123';
const handle = 'pv-1907-3fa91c2e';
const confirmed = 'v2026.09.28-pr1907-1-1-abcdef0';
const newer = 'v2026.09.29-pr1907-2-1-1234567';

function privatePreview(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return {
    machineId: '00000000-0000-4000-8000-000000001907',
    clerkUserId: 'user_owner',
    handle,
    runtimeSlot: handle,
    provisioningClass: 'private-preview',
    sourcePr: 1907,
    confirmedBundleVersion: confirmed,
    status: 'running',
    provisionedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('Private Preview update base', () => {
  let db: PlatformDB;
  let getPresignedGetUrl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    getPresignedGetUrl = vi.fn().mockResolvedValue('https://r2.example/signed-host-bundle');
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  async function seedRelease(version: string, provenance: { sourcePr?: number; sourceAuthor?: string } = {}) {
    return upsertHostBundleRelease(db, {
      version,
      gitCommit: 'c1598218',
      gitRef: 'feature/private-preview',
      buildTime: '2026-09-28T00:00:00.000Z',
      bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`,
      checksumKey: `system-bundles/${version}/matrix-host-bundle.tar.gz.sha256`,
      sha256: 'a'.repeat(64),
      size: 1234,
      ...provenance,
    });
  }

  function app() {
    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: secret,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });
  }

  const releaseUrl = (version: string, forHandle = handle) =>
    `/private-preview-updates/${forHandle}/system-bundles/releases/${version}.json`;

  it('serves only the owner-confirmed release', async () => {
    await seedRelease(confirmed);
    await seedRelease(newer);
    await insertUserMachine(db, privatePreview());

    const served = await app().request(releaseUrl(confirmed));
    expect(served.status).toBe(200);
    await expect(served.json()).resolves.toMatchObject({
      version: confirmed,
      url: 'https://r2.example/signed-host-bundle',
    });

    expect((await app().request(releaseUrl(newer))).status).toBe(404);
  });

  it('never serves channel manifests or release lists under the base', async () => {
    await seedRelease(confirmed);
    await insertUserMachine(db, privatePreview());
    for (const path of [
      `/private-preview-updates/${handle}/system-bundles/channels/stable.json`,
      `/private-preview-updates/${handle}/system-bundles/channels/dev.json`,
      `/private-preview-updates/${handle}/system-bundles/releases`,
      `/private-preview-updates/${handle}/system-bundles/${confirmed}/matrix-host-bundle.tar.gz`,
    ]) {
      expect((await app().request(path)).status, path).toBe(404);
    }
  });

  it('serves nothing for unknown, malformed, customer, or deleted machines', async () => {
    await seedRelease(confirmed);
    await insertUserMachine(db, privatePreview({ deletedAt: '2026-09-28T01:00:00.000Z', status: 'deleted' }));
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000000001',
      clerkUserId: 'user_customer',
      handle: 'alice',
      status: 'running',
      provisionedAt: '2026-09-28T00:00:00.000Z',
    });

    expect((await app().request(releaseUrl(confirmed))).status).toBe(404);
    expect((await app().request(releaseUrl(confirmed, 'pv-1907-0badf00d'))).status).toBe(404);
    expect((await app().request(releaseUrl(confirmed, 'alice'))).status).toBe(404);
    expect((await app().request(releaseUrl(confirmed, 'PV-1907'))).status).toBe(404);
  });

  it('follows the confirmed version after an owner update', async () => {
    await seedRelease(confirmed);
    await seedRelease(newer);
    await insertUserMachine(db, privatePreview());
    await sql`UPDATE user_machines SET confirmed_bundle_version = ${newer} WHERE handle = ${handle}`.execute(db.kysely);

    expect((await app().request(releaseUrl(newer))).status).toBe(200);
    expect((await app().request(releaseUrl(confirmed))).status).toBe(404);
  });

  it('requires a confirmed version on every Private Preview', async () => {
    await expect(insertUserMachine(db, privatePreview({ confirmedBundleVersion: null }))).rejects.toThrow();
  });
});

describe('PR bundle provenance', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function register(version: string, provenance: Record<string, unknown> = {}) {
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret });
    return app.request('/system-bundles/releases', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version,
        gitCommit: 'c1598218',
        gitRef: 'feature/private-preview',
        buildTime: '2026-09-28T00:00:00.000Z',
        bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`,
        sha256: 'a'.repeat(64),
        size: 1234,
        ...provenance,
      }),
    });
  }

  it('records the source PR and author and finds the newest bundle for a PR', async () => {
    expect((await register(confirmed, { sourcePr: 1907, sourceAuthor: 'octo-dev' })).status).toBe(200);
    await sql`UPDATE host_bundle_releases SET created_at = '2026-09-28T00:00:00.000Z' WHERE version = ${confirmed}`.execute(db.kysely);
    expect((await register(newer, { sourcePr: 1907, sourceAuthor: 'octo-dev' })).status).toBe(200);
    expect((await register('v2026.09.29-pr1908-1-1-7654321', { sourcePr: 1908, sourceAuthor: 'octo-dev' })).status).toBe(200);

    await expect(getLatestHostBundleReleaseForPr(db, 1907)).resolves.toMatchObject({
      version: newer,
      sourcePr: 1907,
      sourceAuthor: 'octo-dev',
    });
    await expect(getLatestHostBundleReleaseForPr(db, 1)).resolves.toBeUndefined();
  });

  it('keeps provenance when a retry omits it and rejects conflicting provenance', async () => {
    expect((await register(confirmed, { sourcePr: 1907, sourceAuthor: 'octo-dev' })).status).toBe(200);
    expect((await register(confirmed)).status).toBe(200);
    await expect(getLatestHostBundleReleaseForPr(db, 1907)).resolves.toMatchObject({ version: confirmed });
    expect((await register(confirmed, { sourcePr: 1908, sourceAuthor: 'octo-dev' })).status).toBe(409);
  });

  it('validates provenance at the route boundary', async () => {
    expect((await register(confirmed, { sourcePr: 0 })).status).toBe(400);
    expect((await register(confirmed, { sourcePr: 1_000_000_000 })).status).toBe(400);
    expect((await register(confirmed, { sourcePr: 1907, sourceAuthor: 'not a login' })).status).toBe(400);
  });

  it('keeps provenance out of public release metadata', async () => {
    expect((await register(confirmed, { sourcePr: 1907, sourceAuthor: 'octo-dev' })).status).toBe(200);
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: secret,
      customerVpsObjectStore: {
        getObject: vi.fn(),
        getPresignedGetUrl: vi.fn().mockResolvedValue('https://r2.example/signed'),
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });
    const body = await (await app.request(`/system-bundles/releases/${confirmed}.json`)).json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('sourceAuthor');
    expect(body).not.toHaveProperty('sourcePr');
  });
});
