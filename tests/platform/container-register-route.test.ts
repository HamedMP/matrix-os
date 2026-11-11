import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformContainerRuntimeToken, buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import { createContainerInternalRoutes } from '../../packages/platform/src/substrates/container-internal-routes.js';
import type { ContainerProvider } from '../../packages/platform/src/substrates/container-provider.js';
import { createApp as createPlatformApp } from '../../packages/platform/src/main.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const SECRET = 'p'.repeat(48);
const NOW = new Date('2026-11-11T12:00:00.000Z');
const IDENTITY = { handle: 'alice', machineId: 'ctr-1', runtimeSlot: 'primary' };

function unusedProvider(): ContainerProvider {
  const fail = async (): Promise<never> => { throw new Error('provider must not be called'); };
  return { run: fail, suspend: fail, resume: fail, terminate: fail, describe: fail, list: fail, mintEndpointCredential: fail };
}

describe('POST /internal/containers/:handle/register', () => {
  let db: PlatformDB;
  let onRegistered: ReturnType<typeof vi.fn<(machineId: string) => Promise<void>>>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    onRegistered = vi.fn(async () => {});
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: 'user_alice', handle: 'alice', status: 'starting', imageVersion: null,
      provisionedAt: NOW.toISOString(), substrate: 'container', generation: 2, runtimeTokenEpoch: 2,
    });
    await db.executor.updateTable('user_machines').set({ started_at: NOW }).where('machine_id', '=', 'ctr-1').execute();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function app(overrides: { platformSecret?: string } = {}) {
    const lifecycle = createContainerLifecycleService({
      db, provider: unusedProvider(), buildBootPayload: async () => '{}', now: () => NOW,
    });
    return createContainerInternalRoutes({
      db, lifecycle, platformSecret: overrides.platformSecret ?? SECRET, onRegistered,
      logError: () => {},
    });
  }

  function register(
    routes: { request: ReturnType<typeof app>['request'] },
    body: unknown,
    options: { token?: string; machineId?: string; slot?: string; handle?: string; raw?: string } = {},
  ) {
    const token = options.token ?? buildPlatformContainerRuntimeToken(IDENTITY, SECRET, 2);
    return routes.request(`/internal/containers/${options.handle ?? 'alice'}/register`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-matrix-machine-id': options.machineId ?? 'ctr-1',
        'x-matrix-runtime-slot': options.slot ?? 'primary',
      },
      body: options.raw ?? JSON.stringify(body),
    });
  }

  const BODY = { generation: 2, bundleVersion: '2026.11.11-1' };

  it('moves a starting runtime to running for the current generation and records the bundle', async () => {
    const response = await register(app(), BODY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const machine = await getUserMachine(db, 'ctr-1');
    expect(machine).toMatchObject({ status: 'running', imageVersion: '2026.11.11-1' });
    expect(onRegistered).toHaveBeenCalledWith('ctr-1');
  });

  it('is idempotent for the same generation', async () => {
    const routes = app();
    expect((await register(routes, BODY)).status).toBe(200);
    const again = await register(routes, BODY);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    expect(onRegistered).toHaveBeenCalledTimes(2);
  });

  it('rejects a token from an older epoch with 401 and leaves the runtime starting', async () => {
    const stale = buildPlatformContainerRuntimeToken(IDENTITY, SECRET, 1);
    const response = await register(app(), { ...BODY, generation: 1 }, { token: stale });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('starting');
    expect(onRegistered).not.toHaveBeenCalled();
  });

  it('rejects other credentials: the handle verification token, another machine, slot, or handle', async () => {
    const routes = app();
    const cases = [
      register(routes, BODY, { token: buildPlatformVerificationToken('alice', SECRET) }),
      register(routes, BODY, { machineId: 'ctr-other' }),
      register(routes, BODY, { slot: 'studio' }),
      register(routes, BODY, { handle: 'mallory' }),
      register(routes, BODY, { token: buildPlatformContainerRuntimeToken({ ...IDENTITY, machineId: 'ctr-other' }, SECRET, 2) }),
    ];
    for (const response of await Promise.all(cases)) expect(response.status).toBe(401);
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('starting');
  });

  it('never authenticates a VPS machine through this route', async () => {
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: 'user_bob', handle: 'bob', status: 'provisioning', imageVersion: null,
      provisionedAt: NOW.toISOString(),
    });
    const token = buildPlatformContainerRuntimeToken({ handle: 'bob', machineId: 'vps-1', runtimeSlot: 'primary' }, SECRET, 1);
    const response = await register(app(), { ...BODY, generation: 1 }, { token, machineId: 'vps-1', handle: 'bob' });
    expect(response.status).toBe(401);
    expect((await getUserMachine(db, 'vps-1'))?.status).toBe('provisioning');
  });

  it('refuses a generation other than the current one', async () => {
    const response = await register(app(), { ...BODY, generation: 3 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'stale_generation' });
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('starting');
  });

  it('refuses a runtime that is not starting', async () => {
    await db.executor.updateTable('user_machines').set({ status: 'stopped' }).where('machine_id', '=', 'ctr-1').execute();
    const response = await register(app(), BODY);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_starting' });
    expect(onRegistered).not.toHaveBeenCalled();
  });

  it('validates the body at the boundary', async () => {
    const routes = app();
    for (const body of [{}, { generation: 0, bundleVersion: 'x' }, { generation: 2 }, { ...BODY, extra: true },
      { generation: 2, bundleVersion: 'bad version with spaces' }, { generation: '2', bundleVersion: 'x' }]) {
      const response = await register(routes, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    }
    expect((await register(routes, null, { raw: '{' })).status).toBe(400);
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('starting');
  });

  it('limits the body to 4 KiB', async () => {
    const response = await register(app(), { ...BODY, bundleVersion: 'x'.repeat(5000) });
    expect(response.status).toBe(413);
  });

  it('is unavailable when the platform secret is not configured', async () => {
    const response = await register(app({ platformSecret: '' }), BODY);
    expect(response.status).toBe(503);
  });

  it('asks the runtime to retry when post-registration setup fails, without leaking the cause', async () => {
    onRegistered.mockRejectedValueOnce(new Error('relation ai_funded_runtime_policies at 10.0.0.4 failed'));
    const routes = app();
    const failed = await register(routes, BODY);
    expect(failed.status).toBe(503);
    const text = await failed.text();
    expect(text).not.toContain('10.0.0.4');
    expect(text).not.toContain('ai_funded');
    const retried = await register(routes, BODY);
    expect(retried.status).toBe(200);
  });

  it('is reachable on the platform app ahead of session routing', async () => {
    const platformApp = createPlatformApp({
      db, orchestrator: {} as never, platformSecret: SECRET, env: {}, containerInternalRoutes: app(),
    });
    try {
      const response = await register(platformApp, BODY);
      expect(response.status).toBe(200);
      expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('running');
    } finally { await shutdownPlatformApp(platformApp); }
  });

  it('rate limits registration per runtime', async () => {
    const routes = app();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) statuses.push((await register(routes, BODY)).status);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
