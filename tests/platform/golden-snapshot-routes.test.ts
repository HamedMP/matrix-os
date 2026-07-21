import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import { createGoldenSnapshotRoutes } from '../../packages/platform/src/golden-snapshot-routes.js';
import { GoldenSnapshotCallbackError } from '../../packages/platform/src/golden-snapshot-service.js';
import type { GoldenSnapshotRuntimeConfig } from '../../packages/platform/src/golden-snapshot-schema.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const config: GoldenSnapshotRuntimeConfig = {
  enabled: false,
  buildsEnabled: true,
  rolloutPercent: 0,
  compatibility: {
    provider: 'hetzner', architecture: 'x86', region: 'eu-central', baseImage: 'ubuntu-24.04',
    baseGeneration: 'ubuntu-24.04-v1', bootMode: 'bios', activationAbi: 'host-v1', minimumDiskGb: 40,
  },
  maxBuildAttempts: 5, maxConcurrentBuilds: 2, buildLeaseMs: 300_000, provisioningLeaseMs: 600_000,
  retentionLimit: 20, freshnessMaxAgeMs: 7 * 24 * 60 * 60 * 1000, reconciliationBatchSize: 25,
};

describe('golden snapshot control-plane routes', () => {
  let db: PlatformDB;
  let ids: string[];
  const service = {
    runBuildStep: vi.fn(), runOrphanReconciliationStep: vi.fn(),
    runCleanupStep: vi.fn(), consumeCallback: vi.fn(),
  };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    ids = [
      '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003',
    ];
    service.consumeCallback.mockReset();
    await upsertHostBundleRelease(db, {
      version: 'v1', gitCommit: '1111111', buildTime: '2026-07-01T00:00:00.000Z',
      bundleKey: 'system-bundles/v1/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: '1'.repeat(64), size: 100, createdAt: '2026-07-01T00:00:00.000Z',
    });
  });
  afterEach(async () => destroyTestPlatformDb(db));

  function app() {
    return createGoldenSnapshotRoutes({
      db, service, config, platformSecret: 'platform-secret', operatorSecret: 'operator-secret',
      now: () => '2026-07-03T00:00:00.000Z', idFactory: () => ids.shift()!,
    });
  }

  it('requires platform auth and enqueues duplicate immutable requests idempotently', async () => {
    expect((await app().request('/snapshot-builds', { method: 'POST', body: '{}' })).status).toBe(401);
    const request = () => app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1' }),
    });
    const first = await request();
    const second = await request();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.json()).toMatchObject({ reused: false, status: 'queued' });
    expect(await second.json()).toMatchObject({ reused: true, status: 'queued' });
    const rejectedTestBuild = await app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1', testMode: true }),
    });
    expect(rejectedTestBuild.status).toBe(401);
    const testBuild = await app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer operator-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1', testMode: true }),
    });
    expect(await testBuild.json()).toMatchObject({ reused: false, status: 'queued' });
    expect(await db.executor.selectFrom('golden_snapshots').select(['test_mode']).where('test_mode', '=', true)
      .executeTakeFirst()).toEqual({ test_mode: true });
  });

  it('rejects terminal build reuse until an explicit retry resets it', async () => {
    const request = () => app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1' }),
    });
    expect((await request()).status).toBe(202);
    await db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'failed', status: 'failed', last_error_code: 'validation_failed',
    }).execute();

    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Snapshot build requires retry' });
  });

  it('applies a body limit and strict schema before enqueue', async () => {
    const response = await app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1', padding: 'x'.repeat(9_000) }),
    });
    expect(response.status).toBe(413);
    const unsafeVersion = await app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: "v1'; touch /tmp/injected #" }),
    });
    expect(unsafeVersion.status).toBe(400);
  });

  it('requires the scoped operator credential for build status', async () => {
    await app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1' }),
    });
    const path = '/snapshot-builds/20000000-0000-4000-8000-000000000001';
    expect((await app().request(path, {
      headers: { authorization: 'Bearer platform-secret' },
    })).status).toBe(401);
    expect((await app().request(path, {
      headers: { authorization: 'Bearer operator-secret' },
    })).status).toBe(200);
  });

  it('uses the scoped operator credential for snapshot administration', async () => {
    expect((await app().request('/snapshots', {
      headers: { authorization: 'Bearer platform-secret' },
    })).status).toBe(401);
    expect((await app().request('/snapshots', {
      headers: { authorization: 'Bearer operator-secret' },
    })).status).toBe(200);
  });

  it('passes phase tokens to the service and returns only generic callback errors', async () => {
    service.consumeCallback.mockRejectedValueOnce(new GoldenSnapshotCallbackError('unauthorized'));
    const response = await app().request('/snapshot-builds/20000000-0000-4000-8000-000000000001/callback', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token-long-enough', 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: randomUUID(),
        phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
        builderMachineIdSha256: '2'.repeat(64), builderSshHostKeySha256: '3'.repeat(64),
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Snapshot callback rejected' });

    service.consumeCallback.mockClear();
    const missingToken = await app().request('/snapshot-builds/20000000-0000-4000-8000-000000000001/callback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: randomUUID(),
        phase: 'sanitized', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
        builderMachineIdSha256: '2'.repeat(64), builderSshHostKeySha256: '3'.repeat(64),
      }),
    });
    expect(missingToken.status).toBe(401);
    expect(await missingToken.json()).toEqual({ error: 'Snapshot callback rejected' });
    expect(service.consumeCallback).not.toHaveBeenCalled();
  });

  it('accepts bounded validation identity evidence at the callback boundary', async () => {
    service.consumeCallback.mockResolvedValueOnce(undefined);
    const response = await app().request(
      '/snapshot-builds/20000000-0000-4000-8000-000000000001/callback',
      {
        method: 'POST',
        headers: { authorization: 'Bearer callback-token-long-enough', 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: randomUUID(),
          phase: 'validated', bundleVersion: 'v1', bundleSha256: '1'.repeat(64),
          validationMachineIdSha256: '2'.repeat(64), validationSshHostKeySha256: '3'.repeat(64),
          evidence: {
            exactBundle: true, healthy: true, freshActivation: true,
            uniqueMachineId: true, uniqueSshHostKey: true, forbiddenStateAbsent: true,
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(service.consumeCallback).toHaveBeenCalledWith(
      '20000000-0000-4000-8000-000000000001',
      'callback-token-long-enough',
      expect.objectContaining({ validationMachineIdSha256: '2'.repeat(64) }),
    );
  });

  it('uses the route-specific body limits from the approved contract', async () => {
    const callback = await app().request(
      '/snapshot-builds/20000000-0000-4000-8000-000000000001/callback',
      {
        method: 'POST',
        headers: { authorization: 'Bearer callback-token-long-enough', 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(9_000) }),
      },
    );
    expect(callback.status).toBe(400);

    const headers = { authorization: 'Bearer platform-secret', 'content-type': 'application/json' };
    const retryBody = JSON.stringify({ padding: 'x'.repeat(2_000) });
    const retry = await app().request(
      '/snapshot-builds/20000000-0000-4000-8000-000000000001/retry',
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(retryBody)) },
        body: retryBody,
      },
    );
    expect(retry.status).toBe(413);

    const revoke = await app().request(
      '/snapshots/10000000-0000-4000-8000-000000000001/revoke',
      { method: 'POST', headers, body: JSON.stringify({ reason: 'unsafe', padding: 'x'.repeat(5_000) }) },
    );
    expect(revoke.status).toBe(413);
  });

  it('provides authenticated bounded status and immediate revocation controls without provider details', async () => {
    const enqueue = await app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1' }),
    });
    const { snapshotId } = await enqueue.json() as { snapshotId: string };
    const status = await app().request('/snapshots?limit=10', {
      headers: { authorization: 'Bearer platform-secret' },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ snapshots: [expect.objectContaining({ snapshotId, state: 'candidate' })] });
    expect(JSON.stringify(await app().request('/snapshots?limit=10', {
      headers: { authorization: 'Bearer platform-secret' },
    }).then((response) => response.json()))).not.toContain('providerImageId');

    const revoked = await app().request(`/snapshots/${snapshotId}/revoke`, {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'operator_revoked' }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
  });

  it('retries only a persisted failed build through the authenticated bounded control', async () => {
    const enqueue = await app().request('/snapshot-builds', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ bundleVersion: 'v1' }),
    });
    const ids = await enqueue.json() as { snapshotId: string; buildId: string };
    await db.executor.updateTable('golden_snapshots').set({ state: 'failed', failure_code: 'synthetic_failure' })
      .where('snapshot_id', '=', ids.snapshotId).execute();
    await db.executor.updateTable('golden_snapshot_builds').set({ status: 'failed', phase: 'failed' })
      .where('build_id', '=', ids.buildId).execute();

    const retried = await app().request(`/snapshot-builds/${ids.buildId}/retry`, {
      method: 'POST', headers: { authorization: 'Bearer platform-secret' },
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ retried: true });
    expect(await db.executor.selectFrom('golden_snapshot_builds').select(['status', 'phase'])
      .where('build_id', '=', ids.buildId).executeTakeFirst()).toMatchObject({ status: 'queued', phase: 'requested' });
    expect(await db.executor.selectFrom('golden_snapshots').select('state')
      .where('snapshot_id', '=', ids.snapshotId).executeTakeFirst()).toEqual({ state: 'candidate' });
  });

  it('returns generic JSON when retry or revoke persistence is unavailable', async () => {
    const brokenDb = {
      ...db,
      transaction: async () => { throw new Error('synthetic database path'); },
      executor: new Proxy(db.executor, {
        get(target, property, receiver) {
          if (property === 'updateTable') return () => { throw new Error('synthetic database path'); };
          return Reflect.get(target, property, receiver);
        },
      }),
    } as PlatformDB;
    const brokenApp = createGoldenSnapshotRoutes({
      db: brokenDb, service, config, platformSecret: 'platform-secret',
      now: () => '2026-07-03T00:00:00.000Z', idFactory: () => ids.shift()!,
    });
    const retry = await brokenApp.request('/snapshot-builds/20000000-0000-4000-8000-000000000001/retry', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret' },
    });
    expect(retry.status).toBe(500);
    expect(await retry.json()).toEqual({ error: 'Snapshot retry unavailable' });
    const revoke = await brokenApp.request('/snapshots/10000000-0000-4000-8000-000000000001/revoke', {
      method: 'POST', headers: { authorization: 'Bearer platform-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'operator_revoked' }),
    });
    expect(revoke.status).toBe(500);
    expect(await revoke.json()).toEqual({ error: 'Snapshot revocation unavailable' });
  });
});
