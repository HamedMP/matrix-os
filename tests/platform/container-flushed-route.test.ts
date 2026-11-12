import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformContainerRuntimeToken, buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createContainerLifecycleService, type ContainerBootContext } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import { createContainerInternalRoutes } from '../../packages/platform/src/substrates/container-internal-routes.js';
import type { ContainerProvider } from '../../packages/platform/src/substrates/container-provider.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const SECRET = 'f'.repeat(48);
const NOW = new Date('2026-11-12T10:00:00.000Z');
const IDENTITY = { handle: 'flush-alice', machineId: 'ctr-flush-1', runtimeSlot: 'primary' };
const DIGEST = `sha256:${'e'.repeat(64)}`;

function unusedProvider(): ContainerProvider {
  const fail = async (): Promise<never> => { throw new Error('provider must not be called'); };
  return { run: fail, suspend: fail, resume: fail, terminate: fail, describe: fail, list: fail, mintEndpointCredential: fail };
}

describe('container lifecycle report routes', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: IDENTITY.machineId, clerkUserId: 'user_flush_alice', handle: IDENTITY.handle, status: 'running',
      imageVersion: null, provisionedAt: NOW.toISOString(), substrate: 'container', generation: 2, runtimeTokenEpoch: 2,
    });
    await db.executor.updateTable('user_machines').set({ last_activity_at: new Date(NOW.getTime() - 30 * 60_000) })
      .where('machine_id', '=', IDENTITY.machineId).execute();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function app(overrides: { platformSecret?: string } = {}) {
    const lifecycle = createContainerLifecycleService({
      db, provider: unusedProvider(), buildBootPayload: async () => '{}', now: () => NOW,
    });
    return createContainerInternalRoutes({ db, lifecycle, platformSecret: overrides.platformSecret ?? SECRET, logError: () => {} });
  }

  function post(
    routes: ReturnType<typeof app>,
    route: 'flushed' | 'activity',
    body: unknown,
    options: { token?: string; raw?: string } = {},
  ) {
    return routes.request(`/internal/containers/${IDENTITY.handle}/lifecycle/${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token ?? buildPlatformContainerRuntimeToken(IDENTITY, SECRET, 2)}`,
        'content-type': 'application/json',
        'x-matrix-machine-id': IDENTITY.machineId,
        'x-matrix-runtime-slot': 'primary',
      },
      body: options.raw ?? JSON.stringify(body),
    });
  }

  async function flushRecord() {
    return db.executor.selectFrom('user_machines')
      .select(['last_flush_digest', 'last_flushed_at', 'last_activity_at', 'status'])
      .where('machine_id', '=', IDENTITY.machineId).executeTakeFirstOrThrow();
  }

  describe('flushed', () => {
    it('records the last good flush for the current generation', async () => {
      const response = await post(app(), 'flushed', { generation: 2, manifestDigest: DIGEST });
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const record = await flushRecord();
      expect(record.last_flush_digest).toBe(DIGEST);
      expect(record.last_flushed_at?.toISOString()).toBe(NOW.toISOString());
    });

    it('refuses a replaced generation, so a stale unit cannot vouch for data it no longer owns', async () => {
      const response = await post(app(), 'flushed', { generation: 1, manifestDigest: DIGEST });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'stale_generation' });
      expect((await flushRecord()).last_flush_digest).toBeNull();
    });

    it('records a flush that lands while the runtime needs recovery, and refuses one after a clean stop', async () => {
      await db.executor.updateTable('user_machines').set({ status: 'needs_recovery', failure_code: 'flush_failed' })
        .where('machine_id', '=', IDENTITY.machineId).execute();
      expect((await post(app(), 'flushed', { generation: 2, manifestDigest: DIGEST })).status).toBe(204);
      expect((await flushRecord()).status).toBe('needs_recovery');

      await db.executor.updateTable('user_machines').set({ status: 'stopped', last_flush_digest: null })
        .where('machine_id', '=', IDENTITY.machineId).execute();
      expect((await post(app(), 'flushed', { generation: 2, manifestDigest: DIGEST })).status).toBe(409);
      expect((await flushRecord()).last_flush_digest).toBeNull();
    });

    it('hands the reported flush to a recovery start, so the runtime never hydrates over newer data', async () => {
      expect((await post(app(), 'flushed', { generation: 2, manifestDigest: DIGEST })).status).toBe(204);
      await db.executor.updateTable('user_machines').set({ status: 'needs_recovery', failure_code: 'flush_failed', substrate_ref: null })
        .where('machine_id', '=', IDENTITY.machineId).execute();
      const boots: ContainerBootContext[] = [];
      const provider: ContainerProvider = {
        ...unusedProvider(),
        run: vi.fn(async () => ({ unitId: 'mvm-r', state: 'pending' as const, endpointHost: 'mvm-r.lambda-microvm.eu-west-1.on.aws', createdAt: NOW, expiresAt: null })),
      };
      const lifecycle = createContainerLifecycleService({
        db, provider, now: () => NOW, logError: () => {}, async buildBootPayload(context) { boots.push(context); return '{}'; },
      });
      expect(await lifecycle.ensureStarted(IDENTITY.machineId)).toEqual({ state: 'starting' });
      await lifecycle.drain();
      expect(boots[0]?.recovery).toEqual({ lastFlushDigest: DIGEST, lastFlushedAt: NOW.toISOString() });
    });

    it('validates the body at the boundary and limits it to 4 KiB', async () => {
      const routes = app();
      for (const body of [{}, { generation: 2 }, { generation: 2, manifestDigest: 'sha256:abc' },
        { generation: 2, manifestDigest: DIGEST, extra: 1 }, { generation: '2', manifestDigest: DIGEST }]) {
        const response = await post(routes, 'flushed', body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_request' });
      }
      expect((await post(routes, 'flushed', null, { raw: '{' })).status).toBe(400);
      expect((await post(routes, 'flushed', { generation: 2, manifestDigest: DIGEST, pad: 'x'.repeat(5000) })).status).toBe(413);
      expect((await flushRecord()).last_flush_digest).toBeNull();
    });
  });

  describe('activity', () => {
    it('accepts the advisory report without extending the session', async () => {
      const before = (await flushRecord()).last_activity_at;
      const response = await post(app(), 'activity', { unsettledRuns: 3 });
      expect(response.status).toBe(204);
      expect((await flushRecord()).last_activity_at).toEqual(before);
    });

    it('validates the body and limits it to 4 KiB', async () => {
      const routes = app();
      for (const body of [{}, { unsettledRuns: -1 }, { unsettledRuns: 1.5 }, { unsettledRuns: 1, extra: true }]) {
        expect((await post(routes, 'activity', body)).status).toBe(400);
      }
      expect((await post(routes, 'activity', { unsettledRuns: 1, pad: 'x'.repeat(5000) })).status).toBe(413);
    });
  });

  it.each(['flushed', 'activity'] as const)('authenticates %s with the per-runtime token of the current epoch only', async (route) => {
    const routes = app();
    const body = route === 'flushed' ? { generation: 2, manifestDigest: DIGEST } : { unsettledRuns: 0 };
    for (const token of [
      buildPlatformContainerRuntimeToken(IDENTITY, SECRET, 1),
      buildPlatformVerificationToken(IDENTITY.handle, SECRET),
      buildPlatformContainerRuntimeToken({ ...IDENTITY, machineId: 'ctr-other' }, SECRET, 2),
    ]) {
      const response = await post(routes, route, body, { token });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    expect((await flushRecord()).last_flush_digest).toBeNull();
    expect((await post(app({ platformSecret: '' }), route, body)).status).toBe(503);
  });

  it('rate limits each report route per runtime without starving the others', async () => {
    const routes = app();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) statuses.push((await post(routes, 'activity', { unsettledRuns: 0 })).status);
    expect(statuses.slice(0, 20).every((status) => status === 204)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await post(routes, 'flushed', { generation: 2, manifestDigest: DIGEST })).status).toBe(204);
  });
});
