import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createInternalSyncRoutes } from '../../packages/platform/src/internal-sync-routes.js';
import { createApp } from '../../packages/platform/src/main.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';
import { buildPlatformUserProof } from '../../packages/platform/src/session-routing-websocket.js';
import {
  buildContainerBootPayload,
  CONTAINER_BOOT_PAYLOAD_MAX_BYTES,
  type ContainerBootPayload,
} from '../../packages/platform/src/substrates/container-boot-payload.js';
import { createContainerInternalRoutes } from '../../packages/platform/src/substrates/container-internal-routes.js';
import type { ContainerBootContext } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const SECRET = 'q'.repeat(48);
const MACHINE_ID = '3f0c9a4e-7b1d-4c2a-9e8f-0a1b2c3d4e5f';
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/container-boot-payload-v2.json', import.meta.url), 'utf8')) as {
  normal: ContainerBootPayload;
  recovery: ContainerBootPayload;
};
const DATABASE = {
  host: 'owners.internal.example', port: 5432,
  name: 'mxo_abcdefghijklmnopqrstuvwxyz', user: 'mxr_abcdefghijklmnopqrstuvwxyz', password: 'P'.repeat(43),
};

function context(overrides: Partial<ContainerBootContext> = {}): ContainerBootContext {
  return {
    machineId: MACHINE_ID, clerkUserId: 'user_alice', handle: 'alice', runtimeSlot: 'primary',
    generation: 3, runtimeTokenEpoch: 3, ...overrides,
  };
}

function build(ctx: ContainerBootContext = context()) {
  return JSON.parse(buildContainerBootPayload({
    context: ctx, platform: { url: 'https://platform.internal.example', secret: SECRET }, database: DATABASE,
  })) as ContainerBootPayload;
}

function shape(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value === null ? 'null' : typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]));
}

describe('container boot payload version 2', () => {
  it('has exactly the contract keys, in the shape of the shared fixture', () => {
    const payload = build();
    expect(payload.version).toBe(2);
    expect(shape(payload)).toEqual(shape(FIXTURE.normal));
    expect(Object.keys(payload)).toEqual(Object.keys(FIXTURE.normal));
    expect(payload).toMatchObject({
      machineId: MACHINE_ID, clerkUserId: 'user_alice', handle: 'alice', runtimeSlot: 'primary',
      generation: 3, runtimeTokenEpoch: 3, platform: { url: 'https://platform.internal.example' }, database: DATABASE,
    });
    for (const token of [payload.platform.runtimeToken, payload.gateway.authToken, payload.sync.runtimeToken]) {
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('carries recovery only on a recovery start', () => {
    expect(build()).not.toHaveProperty('recovery');
    const recovery = { lastFlushDigest: `sha256:${'e'.repeat(64)}`, lastFlushedAt: '2026-11-12T00:00:00.000Z' };
    const payload = build(context({ recovery }));
    expect(payload.recovery).toEqual(recovery);
    expect(shape(payload)).toEqual(shape(FIXTURE.recovery));
    expect(build(context({ recovery: { lastFlushDigest: null, lastFlushedAt: null } })).recovery)
      .toEqual({ lastFlushDigest: null, lastFlushedAt: null });
  });

  it('keeps the maximum-length fixture and the largest producible payload well under the 16 KB run-hook limit', () => {
    expect(CONTAINER_BOOT_PAYLOAD_MAX_BYTES).toBe(16 * 1024);
    for (const payload of [FIXTURE.normal, FIXTURE.recovery]) {
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4 * 1024);
    }
    const largest = FIXTURE.recovery;
    const produced = buildContainerBootPayload({
      context: {
        machineId: largest.machineId, clerkUserId: largest.clerkUserId, handle: largest.handle,
        runtimeSlot: largest.runtimeSlot, generation: largest.generation, runtimeTokenEpoch: largest.runtimeTokenEpoch,
        ...(largest.recovery ? { recovery: largest.recovery } : {}),
      },
      platform: { url: largest.platform.url, secret: SECRET },
      database: largest.database,
    });
    expect(Buffer.byteLength(produced)).toBe(Buffer.byteLength(JSON.stringify(largest)));
  });

  it('refuses to produce a payload over the run-hook limit', () => {
    expect(() => buildContainerBootPayload({
      context: context(), platform: { url: 'https://platform.internal.example', secret: SECRET },
      database: { ...DATABASE, password: 'x'.repeat(CONTAINER_BOOT_PAYLOAD_MAX_BYTES) },
    })).toThrow('boot payload too large');
  });

  it('derives a gateway token the gateway uses to check the platform user proof', () => {
    const payload = build();
    const gatewayCheck = createHmac('sha256', payload.gateway.authToken).update('user_alice').digest('hex');
    expect(buildPlatformUserProof('alice', 'user_alice', SECRET)).toBe(gatewayCheck);
  });
});

describe('container boot payload tokens against the platform routes', () => {
  let db: PlatformDB;
  const r2 = {
    getPresignedGetUrl: vi.fn(async () => 'https://objects.example/get'),
    getPresignedPutUrl: vi.fn(), headObject: vi.fn(), createMultipartUpload: vi.fn(), getPresignedPartUrl: vi.fn(),
    getObject: vi.fn(), putObject: vi.fn(), deleteObject: vi.fn(), completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(), listMultipartUploads: vi.fn(), destroy: vi.fn(),
  };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: MACHINE_ID, clerkUserId: 'user_alice', handle: 'alice', status: 'starting', imageVersion: null,
      provisionedAt: '2026-11-12T00:00:00.000Z', substrate: 'container', generation: 3, runtimeTokenEpoch: 3,
    });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function headers(token: string) {
    return {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-matrix-machine-id': MACHINE_ID, 'x-matrix-runtime-slot': 'primary',
    };
  }

  function register(token: string) {
    const lifecycle = { markRegistered: vi.fn(async () => 'ok' as const), recordFlush: vi.fn() };
    const routes = createContainerInternalRoutes({ db, lifecycle, platformSecret: SECRET, logError: () => {} });
    return routes.request('/internal/containers/alice/register', {
      method: 'POST', headers: headers(token), body: JSON.stringify({ generation: 3, bundleVersion: '2026.11.12-1' }),
    });
  }

  function presign(token: string) {
    const orchestrator: Orchestrator = {
      provision: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), upgrade: vi.fn(), rollingRestart: vi.fn(),
      getInfo: vi.fn(), getImage: vi.fn(), listAll: vi.fn().mockReturnValue([]), syncStates: vi.fn(),
    };
    const app = createApp({
      db, orchestrator, platformSecret: SECRET,
      internalSyncRoutes: createInternalSyncRoutes({ db, r2, platformSecret: SECRET, r2PrefixRoot: 'matrixos-sync' }),
    });
    return app.request('/internal/containers/alice/sync/presign/get', {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ key: 'matrixos-sync/user_alice/manifest.json' }),
    });
  }

  it('authenticates registration and the sync broker for the current epoch', async () => {
    const payload = build();
    expect((await register(payload.platform.runtimeToken)).status).toBe(200);
    expect((await presign(payload.sync.runtimeToken)).status).toBe(200);
  });

  it('does not let one route token stand in for another', async () => {
    const payload = build();
    expect((await register(payload.sync.runtimeToken)).status).toBe(401);
    expect((await presign(payload.platform.runtimeToken)).status).toBe(401);
  });

  it('refuses tokens from an older epoch on both routes', async () => {
    const stale = build(context({ generation: 2, runtimeTokenEpoch: 2 }));
    expect((await register(stale.platform.runtimeToken)).status).toBe(401);
    expect((await presign(stale.sync.runtimeToken)).status).toBe(401);
  });
});
