import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { getUserMachine, insertUserMachine, type PlatformDB, type UserMachineRecord } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { prepareOnDemandUpstream } from '../../packages/platform/src/substrates/substrate-wake.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createMetalWakeRig, HANDLE, INGRESS_TOKEN, OWNER, type MetalWakeRig } from './metal-wake-rig.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

/**
 * Spec 2691 / ENG-520, Task P3: every owner entry point wakes a sleeping metal
 * VM before proxying. Ported from feat/2691-container-register
 * tests/platform/session-routing-wake.test.ts and generalized to any
 * startsOnDemand substrate.
 */

const PLATFORM_SECRET = 'platform-secret-123';
const OWNER_SESSION = { host: 'app.matrix-os.com', authorization: `Bearer ${OWNER}` };

describe('waking a metal runtime from every entry point', () => {
  let db: PlatformDB;
  let rig: MetalWakeRig;
  let platform: ReturnType<typeof createApp>;

  async function setup(overrides: Parameters<typeof createMetalWakeRig>[1] = {}, options: Parameters<typeof createMetalWakeRig>[2] = {}) {
    rig = await createMetalWakeRig(db, overrides, options);
    platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: PLATFORM_SECRET,
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      substrateRegistry: rig.substrates,
    });
  }

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (platform) await shutdownPlatformApp(platform);
    await rig?.close();
    await destroyTestPlatformDb(db);
  });

  it.each([
    ['explicit /vm route', '/vm/alice/api/projects?x=1'],
    ['session route', '/api/projects?x=1'],
  ])('owner request to a suspended metal VM resumes it and is proxied in the same request (%s)', async (_label, path) => {
    await setup();
    const response = await platform.request(path, {
      headers: { ...OWNER_SESSION, 'x-matrix-host-auth': 'client-forged' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('runtime');
    expect(response.headers.get('x-matrix-host-auth')).toBeNull();
    expect(rig.resumeCalls()).toHaveLength(1);
    expect((await rig.machine())?.status).toBe('running');
    expect(rig.ingress.requests).toHaveLength(1);
    const [proxied] = rig.ingress.requests;
    expect(proxied).toMatchObject({ method: 'GET', path: '/api/projects?x=1' });
    expect(proxied!.headers.host).toBe('app.matrix-os.com');
    expect(proxied!.headers['x-matrix-host-auth']).toBe(INGRESS_TOKEN);
  });

  it('an owner wake stamps awake_since, clears the scheduled wake, and fences the resume to the generation', async () => {
    await setup({ nextWakeAt: '2026-11-21T13:00:00.000Z', awakeSince: null });
    const before = Date.now();
    const response = await platform.request('/api/projects', { headers: OWNER_SESSION });

    expect(response.status).toBe(200);
    const machine = await rig.machine();
    expect(machine).toMatchObject({ status: 'running', nextWakeAt: null });
    expect(Date.parse(machine?.awakeSince ?? '')).toBeGreaterThanOrEqual(before - 1_000);
    expect(JSON.parse(rig.resumeCalls()[0]?.body ?? '{}')).toEqual({ budgetMs: 8000, expectedGeneration: 3 });
  });

  it('concurrent owner requests share one resume', async () => {
    await setup();
    rig.resume = { kind: 'state', state: 'running', delayMs: 300 };
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      platform.request(index % 2 ? '/api/projects' : '/vm/alice/api/projects', { headers: OWNER_SESSION })));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(rig.resumeCalls()).toHaveLength(1);
    expect(rig.ingress.requests).toHaveLength(6);
    expect((await rig.machine())?.status).toBe('running');
  });

  it('share-link viewer gets not available and does not wake', async () => {
    await setup();
    // Signed-out traffic and another signed-in user never reach hostd or the ingress.
    for (const path of ['/api/projects', '/vm/alice/api/projects', '/vm/alice/']) {
      await platform.request(path, { headers: { host: 'app.matrix-os.com' } });
    }
    const stranger = await platform.request('/vm/alice/api/projects', {
      headers: { host: 'app.matrix-os.com', authorization: 'Bearer user_stranger' },
    });
    expect(stranger.status).toBe(404);
    expect(rig.hostd.requests).toEqual([]);
    expect(rig.ingress.requests).toEqual([]);
    expect((await rig.machine())?.status).toBe('suspended');
  });

  it('wake taking longer than 8 s returns 503 runtimeState waking with Retry-After 3 for JSON and the boot page for navigation', async () => {
    await setup();
    // hostd answers `starting` once its 8 s resume budget is spent.
    rig.resume = { kind: 'state', state: 'starting' };

    for (const [path, init] of [
      ['/vm/alice/api/projects', {}],
      ['/vm/alice/health', {}],
      ['/api/projects', {}],
      ['/vm/alice/api/files/write', { method: 'POST', body: '{"path":"a"}' }],
    ] as const) {
      const response = await platform.request(path, { headers: { ...OWNER_SESSION, accept: 'application/json' }, ...init });
      expect(response.status, path).toBe(503);
      expect(response.headers.get('retry-after'), path).toBe('3');
      expect(response.headers.get('cache-control'), path).toContain('no-store');
      expect(await response.json(), path).toEqual({ error: 'Matrix computer not ready', runtimeState: 'waking' });
    }

    const page = await platform.request('/vm/alice/', { headers: { ...OWNER_SESSION, accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('retry-after')).toBe('3');
    const pageHtml = await page.text();
    expect(pageHtml).toContain('http-equiv="refresh"');
    // A sleeping computer says it is waking, not booting (ENG-520).
    expect(pageHtml).toContain('Waking your Matrix computer');

    // The 503 is answered before proxying, so a client may retry even a POST.
    expect(rig.ingress.requests).toEqual([]);
    expect((await rig.machine())?.status).toBe('suspended');
  });

  it.each([
    ['an unreachable host agent', { kind: 'error', status: 500, error: 'internal' }, { error: 'Matrix computer unavailable', code: 'runtime_unavailable' }, '5'],
    ['a host agent busy with this VM', { kind: 'error', status: 503, error: 'busy' }, { error: 'Matrix computer not ready', runtimeState: 'busy' }, '30'],
    ['a VM that needs recovery', { kind: 'error', status: 409, error: 'conflict' }, { error: 'Matrix computer unavailable', code: 'runtime_unavailable' }, null],
  ] as const)('maps %s to a 503 before proxying', async (_label, behaviour, body, retryAfter) => {
    await setup();
    rig.resume = behaviour;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await platform.request('/vm/alice/api/projects', { headers: OWNER_SESSION });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe(retryAfter);
    expect(await response.json()).toEqual(body);
    expect(rig.ingress.requests).toEqual([]);
    expect((await rig.machine())?.status).toBe('suspended');
    if (retryAfter === null) {
      expect(errors.mock.calls.some(([message]) => String(message).includes('needs_recovery'))).toBe(true);
    }
  });

  it('a wake still in flight when the request wait elapses answers waking and keeps going', async () => {
    await setup({}, { requestWaitMs: 150 });
    // A slow hostd resume: the platform stops holding the request before hostd answers.
    rig.resume = { kind: 'state', state: 'running', delayMs: 700 };

    const first = await platform.request('/vm/alice/api/projects', { headers: OWNER_SESSION });
    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after')).toBe('3');
    expect(await first.json()).toEqual({ error: 'Matrix computer not ready', runtimeState: 'waking' });
    const page = await platform.request('/vm/alice/', { headers: { ...OWNER_SESSION, accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('http-equiv="refresh"');
    expect(rig.ingress.requests).toEqual([]);

    // The in-flight wake completes on its own; the client's retry finds the VM running.
    await vi.waitFor(async () => expect((await rig.machine())?.status).toBe('running'), { timeout: 3_000 });
    const retry = await platform.request('/vm/alice/api/projects', { headers: OWNER_SESSION });
    expect(retry.status).toBe(200);
    expect(rig.resumeCalls()).toHaveLength(1);
  });

  it.each([
    ['GET', undefined],
    ['POST', '{"path":"notes.md"}'],
  ] as const)('a %s to a VM the host put to sleep wakes it and is retried once, never passing runtime_asleep through', async (method, body) => {
    await setup({ status: 'running' });
    rig.ingress.asleepResponses = 1;

    const response = await platform.request('/vm/alice/api/files', { method, headers: OWNER_SESSION, ...(body ? { body } : {}) });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('runtime');
    expect(rig.resumeCalls()).toHaveLength(1);
    expect(rig.ingress.requests.map((req) => req.method)).toEqual([method, method]);
    // The ingress rejected the first attempt before forwarding, so the VM saw the body exactly once.
    if (body) expect(rig.ingress.requests.at(-1)!.body).toBe(body);
    expect((await rig.machine())?.status).toBe('running');
  });

  it('a HEAD to a VM the host put to sleep (bodyless marked 503) wakes it and is retried once', async () => {
    await setup({ status: 'running' });
    rig.ingress.asleepResponses = 1;

    const response = await platform.request('/vm/alice/api/files', { method: 'HEAD', headers: OWNER_SESSION });

    expect(response.status).toBe(200);
    expect(rig.resumeCalls()).toHaveLength(1);
    expect(rig.ingress.requests.map((req) => req.method)).toEqual(['HEAD', 'HEAD']);
    expect((await rig.machine())?.status).toBe('running');
  });

  it('a 503 runtime_asleep body from the VM itself, without the ingress marker, passes through and is never re-sent', async () => {
    await setup({ status: 'running' });
    rig.ingress.vmAsleepBodyResponses = 1;

    const response = await platform.request('/vm/alice/api/files', {
      method: 'POST', headers: OWNER_SESSION, body: '{"path":"notes.md"}',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'runtime_asleep' });
    expect(rig.ingress.requests.filter((req) => req.method === 'POST')).toHaveLength(1);
    expect(rig.resumeCalls()).toHaveLength(0);
    expect((await rig.machine())?.status).toBe('running');
  });

  it('never forwards a client-sent ingress marker and never returns one to the client', async () => {
    await setup({ status: 'running' });
    const response = await platform.request('/vm/alice/api/projects', {
      headers: { ...OWNER_SESSION, 'x-matrix-ingress-error': 'runtime_asleep' },
    });
    expect(response.status).toBe(200);
    expect(rig.ingress.requests.at(-1)!.headers['x-matrix-ingress-error']).toBeUndefined();

    rig.ingress.asleepResponses = 2;
    const asleep = await platform.request('/vm/alice/api/projects', { headers: OWNER_SESSION });
    expect(asleep.status).toBe(503);
    expect(asleep.headers.get('x-matrix-ingress-error')).toBeNull();
  });

  it('the Native Mobile client, sending the owner\'s Clerk bearer, wakes a sleeping VM from /vm/<handle>/health and API routes', async () => {
    await setup();
    // apps/mobile/lib/gateway-client.ts sends `Authorization: Bearer <Clerk session token>` on every /vm/<handle> call.
    const nativeMobile = { host: 'app.matrix-os.com', authorization: `Bearer ${OWNER}`, accept: 'application/json' };

    const health = await platform.request('/vm/alice/health', { headers: nativeMobile });
    expect(health.status).toBe(200);
    expect(rig.resumeCalls()).toHaveLength(1);
    expect((await rig.machine())?.status).toBe('running');

    const api = await platform.request('/vm/alice/api/projects', { headers: nativeMobile });
    expect(api.status).toBe(200);
    expect(rig.ingress.requests.map((req) => req.path)).toEqual(['/health', '/api/projects']);
  });

  it('a WebView app session token alone never wakes a sleeping VM', async () => {
    await setup();
    const response = await platform.request('/apps/notes/?session=alice.opaque-mobile-token', {
      headers: { host: 'app.matrix-os.com' },
    });

    expect(response.status).toBe(503);
    expect(rig.hostd.requests).toEqual([]);
    expect(rig.ingress.requests).toEqual([]);
    expect((await rig.machine())?.status).toBe('suspended');
  });

  it.each([
    ['refused', async (target: MetalWakeRig) => { await target.hostd.close(); }, {}],
    ['timed out', async (target: MetalWakeRig) => { target.hostdHangs = true; }, { hostdTimeoutMs: 200, requestWaitMs: 5_000 }],
  ] as const)('hostd unreachable (%s) answers 503 runtime_unavailable with Retry-After 5 and leaves the record alone', async (_label, breakHostd, options) => {
    await setup({}, options);
    await breakHostd(rig);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await platform.request('/vm/alice/api/projects', { headers: OWNER_SESSION });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual({ error: 'Matrix computer unavailable', code: 'runtime_unavailable' });
    expect(rig.ingress.requests).toEqual([]);
    const machine = await rig.machine();
    expect(machine?.status).toBe('suspended');
    expect(machine?.lastActivityAt).toBeNull();
  });

  it('answers waking when the VM is still asleep after the one retry', async () => {
    await setup({ status: 'running' });
    rig.ingress.asleepResponses = 2;

    const response = await platform.request('/api/projects', { headers: OWNER_SESSION });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('3');
    const text = await response.text();
    expect(text).not.toContain('runtime_asleep');
    expect(JSON.parse(text)).toEqual({ error: 'Matrix computer not ready', runtimeState: 'waking' });
    expect(rig.ingress.requests).toHaveLength(2);
  });

  it('a non-owner reaching a VM the host put to sleep gets not available, without waking', async () => {
    await setup({ status: 'running' });
    rig.ingress.asleepResponses = 1;
    const admin = { authorization: `Bearer ${PLATFORM_SECRET}` };

    const response = await platform.request('/proxy/alice/api/health', { headers: admin });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Matrix computer unavailable', code: 'runtime_unavailable' });
    expect(rig.resumeCalls()).toHaveLength(0);
    expect((await rig.machine())?.status).toBe('suspended');
  });

  it('owner requests update last_activity_at at most once per minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-11-21T12:00:00.000Z');
    vi.setSystemTime(start);
    await setup();

    const at = async (offsetMs: number) => {
      vi.setSystemTime(new Date(start.getTime() + offsetMs));
      expect((await platform.request('/vm/alice/api/projects', { headers: OWNER_SESSION })).status).toBe(200);
    };

    await at(0);
    await vi.waitFor(async () => expect((await rig.machine())?.lastActivityAt).toBe(start.toISOString()));
    await at(30_000);
    await at(59_000);
    // Give a throttled write the chance to land if it were (wrongly) issued.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await rig.machine())?.lastActivityAt).toBe(start.toISOString());
    await at(61_000);
    await vi.waitFor(async () => expect((await rig.machine())?.lastActivityAt)
      .toBe(new Date(start.getTime() + 61_000).toISOString()));
  });

  it('a request that never reaches the runtime does not count as owner activity', async () => {
    await setup();
    rig.resume = { kind: 'state', state: 'starting' };
    expect((await platform.request('/vm/alice/api/projects', { headers: OWNER_SESSION })).status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await rig.machine())?.lastActivityAt).toBeNull();
  });

  it('vps machines are untouched', async () => {
    await setup({ handle: 'metal-other', clerkUserId: 'user_metal_other' });
    await insertUserMachine(db, {
      machineId: 'vps-alice', clerkUserId: OWNER, handle: HANDLE, status: 'running', hetznerServerId: 4242,
      publicIPv4: '203.0.113.50', imageVersion: 'matrix-os-host-dev', provisionedAt: '2026-11-01T00:00:00.000Z',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('vps', { status: 200 }));

    for (const path of ['/vm/alice/api/projects?x=1', '/api/projects?x=1']) {
      fetchMock.mockClear();
      const response = await platform.request(path, { headers: OWNER_SESSION });
      expect(response.status, path).toBe(200);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
      expect(url, path).toBe('https://203.0.113.50:443/api/projects?x=1');
      expect((init.headers as Headers).get('host'), path).toBe('alice.matrix-os.com');
      expect((init.headers as Headers).has('x-matrix-host-auth'), path).toBe(false);
    }
    expect(rig.hostd.requests).toEqual([]);
    expect((await getUserMachine(db, 'vps-alice'))?.lastActivityAt).toBeNull();
  });

  it('the legacy /proxy route reaches a running metal VM with its credential and never wakes one', async () => {
    await setup();
    const admin = { authorization: `Bearer ${PLATFORM_SECRET}` };

    // Like a VPS that is not running, a sleeping VM is not found here; the route never wakes it.
    const asleep = await platform.request('/proxy/alice/api/health', { headers: admin });
    expect(asleep.status).toBe(404);
    expect(rig.hostd.requests).toEqual([]);

    // Wake it through an owner request, then use the legacy route.
    expect((await platform.request('/api/health', { headers: OWNER_SESSION })).status).toBe(200);
    const awake = await platform.request('/proxy/alice/api/health', { headers: { ...admin, 'x-matrix-host-auth': 'forged' } });
    expect(awake.status).toBe(200);
    expect(awake.headers.get('x-matrix-host-auth')).toBeNull();
    const proxied = rig.ingress.requests.at(-1)!;
    expect(proxied.path).toBe('/api/health');
    expect(proxied.headers['x-matrix-host-auth']).toBe(INGRESS_TOKEN);
    expect(proxied.headers.host).toBe('app.matrix-os.com');
  });
});

describe('who may wake an on-demand runtime', () => {
  const machine = {
    machineId: 'metal-1', clerkUserId: OWNER, handle: HANDLE, runtimeSlot: 'primary', generation: 3,
    substrate: 'metal', status: 'suspended', deletedAt: null, metalHostId: 'metal-1', metalVmId: 'vm_x',
  } as UserMachineRecord;

  async function decide(identity: { userId: string; source?: string; handle?: string }, routable = false, record = machine) {
    const ensureRunning = vi.fn(async () => ({ state: 'running' as const }));
    const registry = {
      get: () => ({ ok: true as const, substrate: { kind: 'metal' as const, startsOnDemand: true, resolveUpstream: () => null, ensureRunning } }),
      resolveUpstream: () => (routable ? { kind: 'upstream' as const, upstream: { url: 'https://x', hostHeader: 'x' } } : { kind: 'not_routable' as const }),
    };
    let outcome: Awaited<ReturnType<typeof prepareOnDemandUpstream>> | undefined;
    const app = new Hono();
    app.get('/', async (c: Context) => {
      outcome = await prepareOnDemandUpstream({
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
    ['a WebView app session (platform cannot verify its token)', { userId: '', source: 'mobile-session', handle: HANDLE }],
    ['a mobile session naming the owner without a verified credential', { userId: OWNER, source: 'mobile-session', handle: HANDLE }],
    ['an identity without a source', { userId: OWNER }],
  ])('does not wake for %s and answers not available', async (_label, identity) => {
    const { response, ensureRunning } = await decide(identity);
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Matrix computer unavailable', code: 'runtime_unavailable' });
  });

  it('lets a non-owner reach a runtime that is already routable without waking it', async () => {
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
