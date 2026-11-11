import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import {
  getUserMachine,
  insertUserMachine,
  upsertBillingEntitlement,
  type PlatformDB,
  type UserMachineRecord,
} from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { createApp } from '../../packages/platform/src/main.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider, ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerSubstrate } from '../../packages/platform/src/substrates/container-substrate.js';
import { prepareContainerUpstream } from '../../packages/platform/src/substrates/container-wake.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const OWNER = 'user_freeowner';
const ENDPOINT = 'mvm-1.lambda-microvm.eu-west-1.on.aws';
const CREDENTIAL = { 'X-aws-proxy-auth': 'platform-minted-credential' };
const OWNER_SESSION = { host: 'app.matrix-os.com', authorization: `Bearer ${OWNER}` };

function fakeProvider(): ContainerProvider {
  const unit: ContainerUnit = {
    unitId: 'mvm-1', state: 'pending', endpointHost: ENDPOINT,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 8 * 3_600_000),
  };
  return {
    run: vi.fn(async () => unit),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({ headers: CREDENTIAL, expiresAt: new Date(Date.now() + 30 * 60_000) })),
  };
}

describe('waking a container runtime on request', () => {
  let db: PlatformDB;
  let provider: ContainerProvider;
  let lifecycle: ReturnType<typeof createContainerLifecycleService>;
  let platform: ReturnType<typeof createApp>;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  function build(env: NodeJS.ProcessEnv = {}) {
    provider = fakeProvider();
    lifecycle = createContainerLifecycleService({ db, provider, buildBootPayload: async () => '{}' });
    const container = createContainerSubstrate({
      lifecycle, provider, endpointHostSuffix: '.on.aws', loadMachine: (machineId) => getUserMachine(db, machineId),
    });
    platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123', env,
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      substrateRegistry: createSubstrateRegistry([createVpsSubstrate({ loadMachine: async () => undefined }), container]),
    });
  }

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('runtime', {
      status: 200, headers: { 'x-aws-proxy-auth': 'echoed', 'content-type': 'text/plain' },
    }));
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'freeowner', status: 'stopped', imageVersion: null,
      provisionedAt: new Date().toISOString(), substrate: 'container',
    });
    build();
  });

  afterEach(async () => {
    await lifecycle.shutdown();
    await shutdownPlatformApp(platform);
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  async function registerStartedUnit() {
    await lifecycle.drain();
    const machine = await getUserMachine(db, 'ctr-1');
    expect(await lifecycle.markRegistered('ctr-1', machine!.generation)).toBe('ok');
  }

  it('starts a stopped runtime for its owner and reports waking without proxying', async () => {
    const response = await platform.request('/api/projects', { headers: OWNER_SESSION });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toEqual({ error: 'Matrix computer not ready', runtimeState: 'waking' });
    await lifecycle.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('starting');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a refreshing page for a browser navigation to the explicit route', async () => {
    const response = await platform.request('/vm/freeowner/', { headers: OWNER_SESSION });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('http-equiv="refresh"');
    await lifecycle.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
  });

  it('shares one start between concurrent owner requests', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      platform.request(index % 2 ? '/api/projects' : '/vm/freeowner/api/projects', { headers: OWNER_SESSION })));
    expect(responses.every((response) => response.status === 503)).toBe(true);
    await lifecycle.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
  });

  it('proxies once running with the platform-minted credential and never returns it', async () => {
    await platform.request('/api/projects', { headers: OWNER_SESSION });
    await registerStartedUnit();
    for (const path of ['/api/projects?x=1', '/vm/freeowner/api/projects?x=1']) {
      fetchMock.mockClear();
      const response = await platform.request(path, { headers: { ...OWNER_SESSION, 'x-aws-proxy-auth': 'client-forged' } });
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe('runtime');
      expect(response.headers.get('x-aws-proxy-auth'), path).toBeNull();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://${ENDPOINT}/api/projects?x=1`);
      expect((init.headers as Headers).get('x-aws-proxy-auth')).toBe('platform-minted-credential');
    }
  });

  it('never starts compute for an unauthenticated request', async () => {
    for (const path of ['/api/projects', '/vm/freeowner/api/projects', '/vm/freeowner/']) {
      await platform.request(path, { headers: { host: 'app.matrix-os.com' } });
    }
    // Signed-out traffic may reach the platform's own auth shell, never the runtime endpoint.
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes(ENDPOINT))).toEqual([]);
    await lifecycle.drain();
    expect(provider.run).not.toHaveBeenCalled();
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('stopped');
  });

  it('never starts compute for another signed-in user', async () => {
    const response = await platform.request('/vm/freeowner/api/projects', {
      headers: { host: 'app.matrix-os.com', authorization: 'Bearer user_stranger' },
    });
    expect(response.status).toBe(404);
    await lifecycle.drain();
    expect(provider.run).not.toHaveBeenCalled();
  });

  it('requires the free entitlement when billing is enforced, before any start', async () => {
    await shutdownPlatformApp(platform);
    await lifecycle.shutdown();
    build({ MATRIX_STRIPE_BILLING_ENABLED: 'true' });
    const denied = await platform.request('/api/projects', { method: 'POST', headers: OWNER_SESSION, body: '{}' });
    expect(denied.status).toBe(402);
    await lifecycle.drain();
    expect(provider.run).not.toHaveBeenCalled();
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, new Date()));
    const admitted = await platform.request('/api/projects', { method: 'POST', headers: OWNER_SESSION, body: '{}' });
    expect(admitted.status).toBe(503);
    await lifecycle.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
  });
});

describe('who may wake a container runtime', () => {
  const machine = {
    machineId: 'ctr-1', clerkUserId: OWNER, handle: 'freeowner', runtimeSlot: 'primary', generation: 1,
    substrate: 'container', status: 'stopped', substrateRef: null, privateAddress: null, deletedAt: null,
  } as UserMachineRecord;

  async function decide(identity: { userId: string; source?: string }, routable = false, record = machine) {
    const ensureRunning = vi.fn(async () => ({ state: 'running' as const }));
    const registry = {
      get: () => ({ ok: true as const, substrate: { kind: 'container' as const, startsOnDemand: true, resolveUpstream: () => null, ensureRunning } }),
      resolveUpstream: () => (routable ? { kind: 'upstream' as const, upstream: { url: 'https://x', hostHeader: 'x' } } : { kind: 'not_routable' as const }),
    };
    let outcome: Awaited<ReturnType<typeof prepareContainerUpstream>> | undefined;
    const app = new Hono();
    app.get('/', async (c: Context) => {
      outcome = await prepareContainerUpstream({
        c, db: {} as PlatformDB, substrates: registry, machine: record, identity, respondWithJson: true,
        applyNoStoreHeaders: () => {},
      });
      return outcome.kind === 'respond' ? outcome.response : c.text('proceed');
    });
    const response = await app.request('/');
    return { response, ensureRunning, outcome: outcome! };
  }

  it.each([
    ['a collaborator', { userId: 'user_other', source: 'auth' }],
    ['a share link or capability route', { userId: '', source: 'static-route' }],
    ['a mobile session without a verified user', { userId: OWNER, source: 'mobile-session' }],
    ['an identity without a source', { userId: OWNER }],
  ])('does not start compute for %s and answers not available', async (_label, identity) => {
    const { response, ensureRunning } = await decide(identity);
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Matrix computer unavailable', code: 'runtime_unavailable' });
  });

  it('lets a non-owner reach a container that is already routable without starting it', async () => {
    const { response, ensureRunning } = await decide({ userId: 'user_other', source: 'auth' }, true);
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(await response.text()).toBe('proceed');
  });

  it('leaves VPS machines untouched', async () => {
    const { response, ensureRunning, outcome } = await decide({ userId: OWNER, source: 'auth' }, false,
      { ...machine, substrate: 'vps' });
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('proceed');
    expect(await response.text()).toBe('proceed');
  });
});
