import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostdCapacityResponse, HostdCreateVmRequest } from '@matrix-os/contracts';
import { createAppSessionRoutes } from '../../packages/platform/src/app-session-routes.js';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { loadCustomerVpsCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
import type { CustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import {
  getBillingEntitlement,
  insertUserMachine,
  promoteHostBundleChannel,
  upsertBillingEntitlement,
  upsertHostBundleRelease,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { loadConfiguredFreeTier, type FreeTierConfig } from '../../packages/platform/src/free-tier/config.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { addFreeTierInvite, getFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createFreeTierRuntime } from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import {
  getRuntimeEntitlementDecisionForUser,
  resolveEffectiveBillingEntitlement,
} from '../../packages/platform/src/runtime-entitlement.js';
import { HostdError, type HostdClient } from '../../packages/platform/src/substrates/hostd-client.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createMetalProvisioner } from '../../packages/platform/src/substrates/metal-provisioner.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * Free plan on metal (spec 2691, ENG-520; free-tier policy ported from PR
 * #3414 with the container provider swapped for the metal provisioner). An
 * invited owner with no billing gets a free metal VM from
 * `POST /api/auth/provision-runtime`; everyone else keeps today's 402.
 * Faults detected: a free owner sent to Stripe checkout, an uninvited owner
 * given free compute, a repeat or concurrent request creating a second VM, the
 * free tier running while disabled, a failed metal create stranding an owner
 * whose invite was already used, and a free entitlement unlocking a VPS.
 */

const OWNER = 'user_freeowner';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const BUNDLE_VERSION = 'matrix-os-host-2026.11.20-1';
const ENABLED_ENV = { FREE_TIER_ENABLED: '1', MATRIX_FREE_TIER_MAX_RUNTIMES: '10' };

async function pinStableBundle(db: PlatformDB) {
  await upsertHostBundleRelease(db, {
    version: BUNDLE_VERSION, gitCommit: '1234567', buildTime: NOW.toISOString(),
    bundleKey: `system-bundles/${BUNDLE_VERSION}/matrix-host-bundle.tar.gz`, checksumKey: null,
    sha256: 'c'.repeat(64), size: 100, createdAt: NOW.toISOString(),
  });
  await promoteHostBundleChannel(db, 'stable', BUNDLE_VERSION, NOW.toISOString());
}

function fakeHostd() {
  const capacity = vi.fn(async (): Promise<HostdCapacityResponse> => ({
    memoryAvailableMiB: 60_000, poolFreeBytes: 1024 * 1024 ** 3, runningVms: 0, suspendedVms: 0,
  }));
  let vmCount = 0;
  const createVm = vi.fn(async (_spec: HostdCreateVmRequest) => {
    vmCount += 1;
    return { id: `vm_0123456789abcdef0123456${vmCount}`, privateIPv4: `10.77.0.${vmCount}` };
  });
  const unused = async () => { throw new Error('unexpected hostd call'); };
  const client = {
    capacity, createVm, listVms: unused, destroy: unused, getVm: unused,
    resume: unused, suspend: unused, stop: unused, setPolicy: unused,
  } as unknown as HostdClient;
  return { client, capacity, createVm };
}

function paidEntitlement(): BillingEntitlement {
  return {
    ...buildFreeEntitlement(OWNER, NOW), source: 'stripe', planSlug: 'matrix_starter', status: 'active',
    defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'], stripeSubscriptionId: 'sub_1', stripePriceId: 'price_1',
  };
}

describe('POST /api/auth/provision-runtime: free plan on metal', () => {
  let db: PlatformDB;
  let template: string;
  let hostd: ReturnType<typeof fakeHostd>;
  let machineSeq: number;

  beforeEach(async () => {
    // Size-one pool semantics, so concurrent requests serialize on the owner lock as on real Postgres.
    ({ db } = await createTestPlatformDb({ serializeTransactions: true }));
    await pinStableBundle(db);
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    template = await loadCustomerVpsCloudInitTemplate();
    hostd = fakeHostd();
    machineSeq = 0;
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function metalProvisioner() {
    return createMetalProvisioner({
      db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: () => hostd.client,
      goldenVersion: 'golden-2026.11.20-1',
      config: createTestConfig(),
      cloudInitTemplate: template,
      now: () => NOW,
      sleep: async () => undefined,
      machineIdFactory: () => `6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e${String(++machineSeq).padStart(2, '0')}`,
      tokenFactory: () => ({ token: 'registration-token', hash: hashRegistrationToken('registration-token'), expiresAt: '2026-11-21T13:00:00.000Z' }),
      postgresPasswordFactory: () => 'postgres-secret',
      log: () => {},
    });
  }

  function routesFor(options: {
    env?: NodeJS.ProcessEnv;
    config?: FreeTierConfig;
    resolveEntitlement?: (db: PlatformDB, clerkUserId: string) => Promise<BillingEntitlement | null>;
  } = {}) {
    const config = options.config ?? loadConfiguredFreeTier(options.env ?? ENABLED_ENV, () => {});
    const freeTier = createFreeTierRuntime({ db, config, metal: metalProvisioner(), env: {}, log: () => {} });
    const provision = vi.fn<CustomerVpsService['provision']>(async () => ({
      machineId: 'vps-machine', status: 'provisioning',
    }) as unknown as Awaited<ReturnType<CustomerVpsService['provision']>>);
    const ensureProvisionedPlatformUser = vi.fn(async () => {});
    const routes = createAppSessionRoutes({
      db,
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      customerVpsService: { provision } as Partial<CustomerVpsService> as CustomerVpsService,
      appEnv: {},
      platformJwtSecret: 'j'.repeat(32),
      legacyContainerRoutingEnabled: false,
      logRouteError: () => {},
      applyNoStoreHeaders: (c) => { c.header('Cache-Control', 'no-store'); },
      jsonCustomerVpsError: (c, err) => err instanceof CustomerVpsError && err.status === 402
        ? c.json({ error: 'Billing upgrade required', code: 'billing_required' }, 402)
        : c.json({ error: 'Provisioning failed', code: 'provisioning_failed' }, 503),
      stripeBillingEntitlementsEnabled: () => true,
      resolveEffectiveBillingEntitlement: options.resolveEntitlement
        ?? ((routeDb, clerkUserId, now, runtimeSlot) => resolveEffectiveBillingEntitlement(routeDb, clerkUserId, now, runtimeSlot, {})),
      selectProvisionIdentityForClerkUser: async (_db, userId) => ({ handle: userId.replace('user_', ''), displayName: 'Owner' }),
      ensureProvisionedPlatformUser,
      resolveAppDomainIdentity: async () => null,
      getGatewayUrlForHandle: (handle) => `https://${handle}.invalid`,
      freeRuntimeProvisioner: freeTier?.provisioner,
    });
    return { routes, provision, ensureProvisionedPlatformUser };
  }

  function request(routes: ReturnType<typeof routesFor>['routes'], body: unknown = {}, user = OWNER) {
    return routes.request('/api/auth/provision-runtime', {
      method: 'POST',
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function metalRows(clerkUserId = OWNER) {
    return db.executor.selectFrom('user_machines').selectAll()
      .where('clerk_user_id', '=', clerkUserId).where('deleted_at', 'is', null).execute();
  }

  it('an invited user without billing provisions a free metal runtime', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { routes, provision, ensureProvisionedPlatformUser } = routesFor();

    const response = await request(routes);

    expect(response.status).toBe(202);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      runtime: 'metal', clerkUserId: OWNER, handle: 'freeowner', runtimeSlot: 'primary', status: 'provisioning',
    });
    const rows = await metalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ machine_id: body.machineId, substrate: 'metal', metal_host_id: 'host-a', status: 'provisioning' });
    expect(hostd.createVm).toHaveBeenCalledTimes(1);
    expect(hostd.createVm.mock.calls[0]![0]).toMatchObject({ tier: 'free', bootMiB: 2048, maxMiB: 8192, diskGiB: 20 });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeInstanceOf(Date);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'free', planSlug: 'matrix_free', maxRuntimeSlots: 1 });
    // No Stripe checkout and no VPS: the paid provisioning path is never entered.
    expect(provision).not.toHaveBeenCalled();
    expect(ensureProvisionedPlatformUser).toHaveBeenCalledWith(db, expect.objectContaining({
      clerkUserId: OWNER, handle: 'freeowner', runtimeId: `metal:${String(body.machineId)}`,
    }));
  });

  it('an uninvited user gets 402 billing_required as today', async () => {
    const { routes, provision } = routesFor();

    const response = await request(routes);

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: 'Billing upgrade required', code: 'billing_required' });
    expect(await metalRows()).toHaveLength(0);
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
    expect(hostd.capacity).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it('a second provision returns the existing runtime (idempotent through the unique index)', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { routes } = routesFor();

    const first = await (await request(routes)).json() as { machineId: string };
    const second = await request(routes);

    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ runtime: 'metal', machineId: first.machineId });
    expect(await metalRows()).toHaveLength(1);
    expect(hostd.createVm).toHaveBeenCalledTimes(1);
  });

  it('concurrent first requests create one runtime and one VM', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { routes } = routesFor();

    const responses = await Promise.all([request(routes), request(routes), request(routes)]);

    expect(responses.map((response) => response.status)).toEqual([202, 202, 202]);
    const ids = await Promise.all(responses.map(async (response) => (await response.json() as { machineId: string }).machineId));
    expect(new Set(ids).size).toBe(1);
    expect(await metalRows()).toHaveLength(1);
    expect(hostd.createVm).toHaveBeenCalledTimes(1);
  });

  it('FREE_TIER_ENABLED=0 disables free provisioning', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { routes } = routesFor({ env: { ...ENABLED_ENV, FREE_TIER_ENABLED: '0' } });

    const implicit = await request(routes);
    expect(implicit.status).toBe(402);
    const explicit = await request(routes, { planSlug: 'matrix_free' });
    expect(explicit.status).toBe(503);
    expect(await explicit.json()).toMatchObject({ code: 'free_tier_unavailable' });

    expect(await metalRows()).toHaveLength(0);
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
    expect(hostd.createVm).not.toHaveBeenCalled();
  });

  it('answers an explicit free request from an uninvited owner with the waitlist', async () => {
    const response = await request(routesFor().routes, { planSlug: 'matrix_free' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Free plan is invite only', code: 'waitlisted' });
    expect(await metalRows()).toHaveLength(0);
  });

  it('rejects free-plan requests that select a region, machine, tools, or another slot', async () => {
    const routes = routesFor().routes;
    for (const extra of [{ regionSlug: 'region_fsn1' }, { serverType: 'cpx22' }, { runtime: 'secondary' }]) {
      expect((await request(routes, { planSlug: 'matrix_free', ...extra })).status).toBe(400);
    }
  });

  it('answers busy at the free ceiling and leaves the invite unconsumed', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement('user_other', NOW));
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const response = await request(routesFor({ config: { maxRuntimes: 1, inviteRequired: true } }).routes);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ error: 'Free capacity is full', code: 'busy' });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
    expect(await metalRows()).toHaveLength(0);
  });

  it('keeps an admitted owner entitled after a metal capacity failure, so a retry provisions', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { routes } = routesFor();
    hostd.createVm.mockRejectedValueOnce(new HostdError('pool_full'));

    const busy = await request(routes);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('60');
    expect(await busy.json()).toMatchObject({ code: 'busy' });

    const retry = await request(routes);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ runtime: 'metal', status: 'provisioning' });
    expect(hostd.createVm).toHaveBeenCalledTimes(2);
  });

  it('never turns a lapsed paid owner into a free one', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...paidEntitlement(), status: 'canceled', stripeSubscriptionId: 'sub_old' });
    const routes = routesFor().routes;

    expect((await request(routes)).status).toBe(402);
    const explicit = await request(routes, { planSlug: 'matrix_free' });
    expect(explicit.status).toBe(409);
    expect(await explicit.json()).toMatchObject({ code: 'free_plan_unavailable' });
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe', stripeSubscriptionId: 'sub_old' });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
    expect(await metalRows()).toHaveLength(0);
  });

  it('leaves the paid path unchanged for an entitled paid owner', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { routes, provision } = routesFor({ resolveEntitlement: async () => paidEntitlement() });

    const response = await request(routes);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ runtime: 'customer_vps', machineId: 'vps-machine' });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(hostd.createVm).not.toHaveBeenCalled();
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
  });
});

describe('runtime access for a free owner', () => {
  let db: PlatformDB;
  const env = { MATRIX_STRIPE_BILLING_ENABLED: 'true' };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('allows the owner through to a metal runtime', async () => {
    await insertUserMachine(db, {
      machineId: 'metal-1', clerkUserId: OWNER, handle: 'freeowner', status: 'running',
      provisionedAt: NOW.toISOString(), substrate: 'metal', metalHostId: 'host-a',
    });
    const decision = await getRuntimeEntitlementDecisionForUser(db, OWNER, env, 'primary', 'customer', NOW);
    expect(decision).toMatchObject({ status: 'active', runtimeProxyAllowed: true });
    const unscoped = await getRuntimeEntitlementDecisionForUser(db, OWNER, env, undefined, 'customer', NOW);
    expect(unscoped.runtimeProxyAllowed).toBe(true);
  });

  it('refuses the owner a VPS runtime', async () => {
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: OWNER, handle: 'freeowner', status: 'running', provisionedAt: NOW.toISOString(),
    });
    const decision = await getRuntimeEntitlementDecisionForUser(db, OWNER, env, 'primary', 'customer', NOW);
    expect(decision).toMatchObject({ runtimeProxyAllowed: false });
  });
});
