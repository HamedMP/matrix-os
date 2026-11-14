import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { getUserMachine, insertUserMachine, upsertBillingEntitlement, type PlatformDB } from '../../packages/platform/src/db.js';
import { DEFAULT_COMPUTE_CAP_CONFIG, monthStartUtc } from '../../packages/platform/src/free-tier/compute-meter.js';
import { createApp } from '../../packages/platform/src/main.js';
import { isPlansEntryRequest } from '../../packages/platform/src/substrates/container-plans-route.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { PLANS_PATH } from '../../packages/platform/src/substrates/compute-cap-page.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider, ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerSubstrate } from '../../packages/platform/src/substrates/container-substrate.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

/**
 * "See paid plans" on the compute-cap page links to /?plans=1. A container
 * owner's shell is served by their unit, which is stopped at the cap, so the
 * platform answers that entry point from its own app shell and never wakes
 * the unit. VPS owners keep proxying to their computer.
 */

const OWNER = 'user_plansowner';
const ENDPOINT = 'mvm-1.lambda-microvm.eu-west-1.on.aws';
const AUTH_SHELL = 'http://127.0.0.1:3200';

function fakeProvider(now: () => Date): ContainerProvider {
  const unit: ContainerUnit = {
    unitId: 'mvm-1', state: 'pending', endpointHost: ENDPOINT, createdAt: now(), expiresAt: new Date(now().getTime() + 8 * 3_600_000),
  };
  return {
    run: vi.fn(async () => unit),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({ headers: { 'X-aws-proxy-auth': 'minted' }, expiresAt: new Date(now().getTime() + 30 * 60_000) })),
  };
}

function session(userId: string) {
  return { host: 'app.matrix-os.com', authorization: `Bearer ${userId}` };
}

function fetchTargets(fetchMock: ReturnType<typeof vi.spyOn>): string[] {
  return fetchMock.mock.calls.map(([target]) => String(target));
}

describe('the plans entry point for container owners', () => {
  let db: PlatformDB;
  let lifecycle: ReturnType<typeof createContainerLifecycleService>;
  let provider: ContainerProvider;
  let platform: ReturnType<typeof createApp>;
  let ensureRunning: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  async function build(input: { atCap: boolean }) {
    const now = () => new Date();
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'plansowner', status: 'stopped', imageVersion: null,
      provisionedAt: now().toISOString(), substrate: 'container',
    });
    if (input.atCap) {
      await db.executor.insertInto('runtime_compute_usage').values({
        clerk_user_id: OWNER, month_start: monthStartUtc(now()).toISOString().slice(0, 10),
        billed_ms: DEFAULT_COMPUTE_CAP_CONFIG.capMs, export_ms: 0, export_wakes: 0,
      }).execute();
    }
    provider = fakeProvider(now);
    lifecycle = createContainerLifecycleService({ db, provider, buildBootPayload: async () => '{}', computeCap: DEFAULT_COMPUTE_CAP_CONFIG, now });
    const container = createContainerSubstrate({
      lifecycle, provider, endpointHostSuffix: '.on.aws', loadMachine: (machineId) => getUserMachine(db, machineId), now,
    });
    ensureRunning = vi.spyOn(container, 'ensureRunning');
    platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123', env: {},
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      substrateRegistry: createSubstrateRegistry([createVpsSubstrate({ loadMachine: async () => undefined }), container]),
    });
  }

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('platform plans shell', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
  });

  afterEach(async () => {
    await lifecycle?.shutdown();
    if (platform) await shutdownPlatformApp(platform);
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  it('serves the plans screen to a capped owner from the platform app shell without waking the unit', async () => {
    await build({ atCap: true });
    const response = await platform.request(PLANS_PATH, { headers: session(OWNER) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('platform plans shell');
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/?plans=1`]);
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
    expect((await getUserMachine(db, 'ctr-1'))?.status).toBe('stopped');
  });

  it('serves the plans screen to a running owner from the platform app shell, not the unit', async () => {
    await build({ atCap: false });
    await platform.request('/api/system/info', { headers: session(OWNER) });
    await lifecycle.drain();
    const machine = (await getUserMachine(db, 'ctr-1'))!;
    expect(await lifecycle.markRegistered('ctr-1', machine.generation)).toBe('ok');
    ensureRunning.mockClear();
    fetchMock.mockClear();

    const response = await platform.request(PLANS_PATH, { headers: session(OWNER) });
    expect(response.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/?plans=1`]);
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('still proxies the plain root and other paths to the unit', async () => {
    await build({ atCap: false });
    await platform.request('/', { headers: session(OWNER) });
    expect(ensureRunning).toHaveBeenCalled();
    expect(fetchTargets(fetchMock).some((target) => target.startsWith(AUTH_SHELL))).toBe(false);
  });

  it('keeps the unauthenticated path (the unrouted app shell) and wakes nothing', async () => {
    await build({ atCap: true });
    await platform.request(PLANS_PATH, { headers: { host: 'app.matrix-os.com' } });
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/?plans=1`]);
  });

  it('never routes another signed-in user to the owner\'s unit', async () => {
    await build({ atCap: false });
    await platform.request(PLANS_PATH, { headers: session('user_stranger') });
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(fetchTargets(fetchMock).some((target) => target.includes(ENDPOINT))).toBe(false);
  });
});

describe('the plans entry point for VPS owners', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  it('keeps proxying /?plans=1 to the running VPS', async () => {
    await insertUserMachine(db, {
      machineId: 'machine-alice', clerkUserId: 'user_alice', handle: 'alice', status: 'running', hetznerServerId: 4242,
      publicIPv4: '203.0.113.50', imageVersion: 'matrix-os-host-dev', provisionedAt: '2026-11-01T00:00:00.000Z',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('vps shell', { status: 200 }));
    const platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }),
    });
    const response = await platform.request(PLANS_PATH, { headers: session('clerk-session') });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('vps shell');
    expect(fetchTargets(fetchMock)).toHaveLength(1);
    expect(fetchTargets(fetchMock)[0]).toContain('203.0.113.50');
    expect(fetchTargets(fetchMock)[0]).toContain('plans=1');
    await shutdownPlatformApp(platform);
  });
});

describe('the plans screen data for a free container owner', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('reports no paid access, so the shell shows the plans, and lets checkout start', async () => {
    const now = new Date('2026-11-14T00:00:00.000Z');
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'plansowner', status: 'stopped', imageVersion: null,
      provisionedAt: now.toISOString(), substrate: 'container',
    });
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, now));
    const stripe: StripeBillingClient = {
      apiTimeoutMs: 10_000,
      createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session', id: 'cs_test' }),
      expireCheckoutSession: vi.fn(),
      retrieveCheckoutSession: vi.fn(),
      retrieveRecurringPrice: vi.fn(),
      createPortalSession: vi.fn(),
      constructWebhookEvent: vi.fn(),
    };
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db, stripe, env: { STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder_monthly', STRIPE_WEBHOOK_SECRET: 'whsec_test' },
      resolveClerkUserId: () => Promise.resolve(OWNER), now: () => now,
    }));

    const status = await app.request('/billing/status?runtimeSlot=primary');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ access: { runtimeProxyAllowed: false } });

    const checkout = await app.request('/billing/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly', regionSlug: 'region_fsn1' }),
    });
    expect(checkout.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(1);
  });
});

describe('isPlansEntryRequest', () => {
  it('matches only a GET or HEAD of the root with a plans parameter', () => {
    expect(isPlansEntryRequest('GET', 'https://app.matrix-os.com/?plans=1')).toBe(true);
    expect(isPlansEntryRequest('HEAD', 'https://app.matrix-os.com/?plans=1&runtime=primary')).toBe(true);
    expect(isPlansEntryRequest('POST', 'https://app.matrix-os.com/?plans=1')).toBe(false);
    expect(isPlansEntryRequest('GET', 'https://app.matrix-os.com/')).toBe(false);
    expect(isPlansEntryRequest('GET', 'https://app.matrix-os.com/api/chats?plans=1')).toBe(false);
    expect(isPlansEntryRequest('GET', 'https://app.matrix-os.com/runtime?plans=1')).toBe(false);
  });
});
