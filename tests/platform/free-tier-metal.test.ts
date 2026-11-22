import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  insertCheckoutAttempt,
  insertUserMachine,
  promoteHostBundleChannel,
  upsertBillingEntitlement,
  upsertHostBundleRelease,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { loadConfiguredFreeTier, type FreeTierConfig } from '../../packages/platform/src/free-tier/config.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { addFreeTierInvite, getFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createFreeRuntimeProvisioner, createFreeTierRuntime } from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import { resolveEffectiveBillingEntitlementForSlot } from '../../packages/platform/src/billing-entitlement-resolver.js';
import { getRuntimeAccessDecision, loadStripePriceCatalog } from '../../packages/platform/src/billing.js';
import { recomputeStripeSummary } from '../../packages/platform/src/billing/stripe-webhook-projection.js';
import { createPrebillingIntent } from '../../packages/platform/src/prebilling-provisioning-store.js';
import {
  getRuntimeEntitlementDecisionForUser,
  resolveEffectiveBillingEntitlement,
} from '../../packages/platform/src/runtime-entitlement.js';
import { HostdError, type HostdClient } from '../../packages/platform/src/substrates/hostd-client.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createMetalProvisioner } from '../../packages/platform/src/substrates/metal-provisioner.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

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
const ENABLED_ENV = { MATRIX_FREE_TIER_ENABLED: '1', MATRIX_FREE_TIER_MAX_RUNTIMES: '10' };

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
    memoryAvailableMiB: 60_000, poolFreeBytes: 1024 * 1024 ** 3, runningVms: 0, suspendedVms: 0, thinPool: { dataPercent: 20, metadataPercent: 5 },
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

const FREE = { planSlug: 'matrix_free' };
const EARLIER = '2026-10-01T00:00:00.000Z';
const LATER = '2026-12-01T00:00:00.000Z';
const PRICE_ENV = { STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_1' };

function endedPaid(): BillingEntitlement {
  return {
    ...buildFreeEntitlement(OWNER, new Date(EARLIER)), source: 'stripe', planSlug: 'matrix_starter',
    status: 'canceled', stripeSubscriptionId: 'sub_old', allowedServerTypes: ['cpx22'], defaultServerType: 'cpx22',
  };
}

async function insertSubscriptionRow(db: PlatformDB, input: { id: string; runtimeSlot: string; status: string }) {
  await db.executor.insertInto('billing_subscriptions').values({
    stripe_subscription_id: input.id, stripe_customer_id: 'cus_1', clerk_user_id: OWNER, runtime_slot: input.runtimeSlot,
    plan_slug: 'matrix_starter', stripe_price_id: 'price_1', billing_interval: 'monthly', price_unit_amount_minor: null,
    price_currency: null, price_interval_count: null, price_quantity: null, status: input.status, current_period_end: null,
    grace_period_ends_at: null, trial_started_at: null, trial_ends_at: null, trial_converted_at: null,
    first_trial_payment_failed_at: null, latest_event_created_at: EARLIER, latest_event_id: 'evt_1',
    latest_invoice_event_created_at: null, latest_invoice_event_id: null, updated_at: EARLIER,
  } as never).execute();
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
  let clock: Date;

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
    clock = NOW;
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function metalProvisioner() {
    return createMetalProvisioner({
      db,
      hosts: createMetalHostsRepository(db.kysely),
      clientFor: () => hostd.client,
      // The golden disk is built from the pinned bundle and named after it.
      goldenVersion: BUNDLE_VERSION,
      config: createTestConfig(),
      cloudInitTemplate: template,
      now: () => clock,
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
    expect(hostd.createVm.mock.calls[0]![0]).toMatchObject({ tier: 'free', bootMiB: 2048, maxMiB: 8192, diskGiB: 40 });
    // Free owners get only Claude Code and Codex preinstalled; the request names no tools.
    expect((hostd.createVm.mock.calls[0]![0] as { userData: string }).userData).toMatch(/^\s*MATRIX_DEVELOPER_TOOLS='codex claude-code'$/m);
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeInstanceOf(Date);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'free', planSlug: 'matrix_free', maxRuntimeSlots: 1 });
    // No Stripe checkout and no VPS: the paid provisioning path is never entered.
    expect(provision).not.toHaveBeenCalled();
    expect(ensureProvisionedPlatformUser).toHaveBeenCalledWith(db, expect.objectContaining({
      clerkUserId: OWNER, handle: 'freeowner', runtimeId: `metal:${String(body.machineId)}`,
    }));
  });

  it('a looping free provision request is throttled and stops at the attempt ceiling', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    hostd.createVm.mockRejectedValue(new HostdError('internal'));
    const { routes } = routesFor();

    // First build, then one rebuild, both failing at hostd create.
    expect((await request(routes)).status).toBe(503);
    expect((await request(routes)).status).toBe(503);
    // A further rebuild inside the window is throttled before hostd.
    const throttled = await request(routes);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: 'retry_throttled' });

    clock = new Date(NOW.getTime() + 60_000);
    expect((await request(routes)).status).toBe(503);
    clock = new Date(NOW.getTime() + 2 * 60_000);
    const exhausted = await request(routes);
    expect(exhausted.status).toBe(409);
    expect(await exhausted.json()).toMatchObject({ code: 'retry_exhausted' });
    expect(hostd.createVm).toHaveBeenCalledTimes(3);
    expect((await metalRows())[0]).toMatchObject({ attempt: 3, status: 'failed' });
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

  it('MATRIX_FREE_TIER_ENABLED=0 disables free provisioning', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { routes } = routesFor({ env: { ...ENABLED_ENV, MATRIX_FREE_TIER_ENABLED: '0' } });

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

  // ENG-520 P7 (ported from PR #3437): P5 refused every owner with a paid
  // billing history. A former paid owner whose paid rights have all ended may
  // now take the free plan; any paid right still live keeps them paid.
  it.each([
    { name: 'active', changes: { status: 'active' as const } },
    { name: 'trialing', changes: { status: 'trialing' as const } },
    { name: 'past due', changes: { status: 'past_due' as const } },
    { name: 'unpaid', changes: { status: 'unpaid' as const } },
    { name: 'incomplete', changes: { status: 'incomplete' as const } },
    { name: 'canceled within its grace period', changes: { gracePeriodEndsAt: LATER } },
    { name: 'canceled before its effective end', changes: { effectiveUntil: LATER } },
  ])('refuses a paid owner whose entitlement is $name and leaves it untouched', async ({ changes }) => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...endedPaid(), ...changes });
    const routes = routesFor().routes;

    const explicit = await request(routes, { planSlug: 'matrix_free' });
    expect(explicit.status).toBe(409);
    expect(await explicit.json()).toMatchObject({ code: 'free_plan_unavailable' });
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe', stripeSubscriptionId: 'sub_old' });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
    expect(await metalRows()).toHaveLength(0);
    expect(hostd.createVm).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'canceled', changes: {} },
    { name: 'ended', changes: { status: 'ended' as const } },
    { name: 'canceled after its grace period', changes: { gracePeriodEndsAt: EARLIER } },
    { name: 'canceled past its effective end', changes: { effectiveUntil: EARLIER } },
  ])('lets a former paid owner whose entitlement is $name take the free plan', async ({ changes }) => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...endedPaid(), ...changes });
    const response = await request(routesFor().routes, { planSlug: 'matrix_free' });
    expect(response.status).toBe(202);
    expect(await metalRows()).toHaveLength(1);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({
      source: 'free', planSlug: 'matrix_free', status: 'active', stripeSubscriptionId: null,
    });
  });

  it('gives a former paid owner with an open paid checkout no free admission', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    await insertCheckoutAttempt(db, { id: 'att-resub', clerkUserId: OWNER, stripeSessionId: 'cs_resub', createdAt: new Date(Date.now() - 60_000).toISOString() });
    const explicit = await request(routesFor().routes, FREE);
    expect(explicit.status).toBe(409);
    expect(await explicit.json()).toMatchObject({ code: 'checkout_pending' });
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe', stripeSubscriptionId: 'sub_old' });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
    expect(hostd.createVm).not.toHaveBeenCalled();
  });

  it('offers the free plan to a former paid owner on the implicit path as well', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    const response = await request(routesFor().routes);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ runtime: 'metal' });
  });

  it('refuses a former paid owner while another subscription or an override is still live', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    await insertSubscriptionRow(db, { id: 'sub_extra', runtimeSlot: 'extra', status: 'past_due' });
    expect((await request(routesFor().routes, FREE)).status).toBe(409);

    await db.executor.updateTable('billing_subscriptions').set({ status: 'canceled', grace_period_ends_at: LATER }).execute();
    expect((await request(routesFor().routes, FREE)).status).toBe(409);

    await db.executor.deleteFrom('billing_subscriptions').execute();
    await db.executor.insertInto('billing_entitlement_overrides').values({ id: 'override_1', clerk_user_id: OWNER,
      plan_slug: 'internal', status: 'active', max_runtime_slots: 1, included_runtime_slots: 1, addon_runtime_slots: 0,
      default_server_type: 'cpx22', allowed_server_types: '["cpx22"]', reason: 'support', created_by: 'operator',
      expires_at: null, revoked_at: null, created_at: EARLIER }).execute();
    expect((await request(routesFor().routes, FREE)).status).toBe(409);
    expect(await metalRows()).toHaveLength(0);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe' });
  });

  it('gives a former paid owner runtime access after free signup although their canceled subscription is retained', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    await insertSubscriptionRow(db, { id: 'sub_old', runtimeSlot: 'primary', status: 'canceled' });
    expect((await request(routesFor().routes, FREE)).status).toBe(202);
    const entitlement = await resolveEffectiveBillingEntitlementForSlot(db, OWNER, NOW, 'primary', PRICE_ENV);
    expect(entitlement).toMatchObject({ source: 'free', planSlug: 'matrix_free' });
    expect(getRuntimeAccessDecision(entitlement, NOW, 'metal')).toMatchObject({ runtimeProxyAllowed: true });
  });

  describe('a Stripe webhook after a former paid owner took the free plan', () => {
    const LATER_AT = new Date('2026-11-22T10:00:00.000Z');
    async function takeFreeWithRetainedSubscription() {
      await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
      await upsertBillingEntitlement(db, endedPaid());
      await insertSubscriptionRow(db, { id: 'sub_old', runtimeSlot: 'primary', status: 'canceled' });
      expect((await request(routesFor().routes, FREE)).status).toBe(202);
    }
    /** The webhook handler's two writes: recompute the owner's Stripe summary, then persist it. */
    async function acceptWebhook() {
      const summary = await recomputeStripeSummary(db, OWNER, loadStripePriceCatalog(PRICE_ENV), PRICE_ENV, LATER_AT);
      if (summary) await upsertBillingEntitlement(db, summary);
    }

    it('keeps the free entitlement when the update is for the still-canceled subscription', async () => {
      await takeFreeWithRetainedSubscription();
      await acceptWebhook();
      expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'free', planSlug: 'matrix_free' });
      const entitlement = await resolveEffectiveBillingEntitlementForSlot(db, OWNER, LATER_AT, 'primary', PRICE_ENV);
      expect(getRuntimeAccessDecision(entitlement, LATER_AT, 'metal')).toMatchObject({ runtimeProxyAllowed: true });
    });

    it('lets a live subscription replace the free entitlement', async () => {
      await takeFreeWithRetainedSubscription();
      await db.executor.updateTable('billing_subscriptions').set({ status: 'active', latest_event_id: 'evt_2' }).execute();
      await acceptWebhook();
      expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe', status: 'active', stripeSubscriptionId: 'sub_old' });
    });
  });

  it('refuses a former paid owner who still has a live VPS in any slot', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    await insertUserMachine(db, {
      machineId: 'vps-extra', clerkUserId: OWNER, handle: 'freeowner-extra', runtimeSlot: 'extra', status: 'stopped',
      imageVersion: 'v1', provisionedAt: NOW.toISOString(), activationState: 'authorized',
    });
    const response = await request(routesFor().routes, FREE);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'runtime_exists' });
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe' });

    await db.executor.updateTable('user_machines').set({ deleted_at: EARLIER, status: 'deleted' }).execute();
    expect((await request(routesFor().routes, FREE)).status).toBe(202);
  });

  it('lets a later Stripe reactivation replace the free entitlement even if its clock reads earlier', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    const reactivation = { ...endedPaid(), status: 'active' as const, effectiveFrom: NOW.toISOString(), updatedAt: NOW.toISOString() };
    const provisioner = createFreeRuntimeProvisioner({
      db, config: { maxRuntimes: 10, inviteRequired: true }, metal: metalProvisioner(), env: {},
      now: () => new Date(NOW.getTime() + 1_000),
    });
    expect((await provisioner.provision({ clerkUserId: OWNER, handle: 'freeowner' })).kind).toBe('created');
    await upsertBillingEntitlement(db, reactivation);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe', status: 'active' });
  });

  it('gives an invited owner with a settling paid checkout no free admission', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await insertCheckoutAttempt(db, { id: 'att-1', clerkUserId: OWNER, stripeSessionId: 'cs_open', createdAt: new Date(Date.now() - 60_000).toISOString() });
    const routes = routesFor().routes;

    expect((await request(routes)).status).toBe(402);
    const explicit = await request(routes, { planSlug: 'matrix_free' });
    expect(explicit.status).toBe(409);
    expect(await explicit.json()).toMatchObject({ code: 'checkout_pending' });
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
    expect(hostd.createVm).not.toHaveBeenCalled();
  });

  it('gives no free admission while an older paid checkout session is still open', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    // Stripe sessions stay open for up to 24 hours, well past the settling screen's window.
    await insertCheckoutAttempt(db, { id: 'att-old', clerkUserId: OWNER, stripeSessionId: 'cs_open_old', createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
    expect((await request(routesFor().routes)).status).toBe(402);
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
    expect(hostd.createVm).not.toHaveBeenCalled();
  });

  it('gives an invited owner with an active prebilling intent no free admission', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    // The checkout attempt itself has expired; only the prebilling intent is still active.
    await insertCheckoutAttempt(db, {
      id: 'checkout-1', clerkUserId: OWNER, stripeSessionId: 'cs_old', status: 'expired', createdAt: '2026-11-01T00:00:00.000Z',
    });
    await createPrebillingIntent(db, {
      id: 'intent-1', checkoutAttemptId: 'checkout-1', clerkUserId: OWNER, runtimeSlot: 'primary',
      planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1',
      serverType: 'cpx32', developerTools: [], createdAt: NOW.toISOString(),
    });
    expect((await request(routesFor().routes)).status).toBe(402);
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
    expect(hostd.createVm).not.toHaveBeenCalled();
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

describe.skipIf(!freeTierPostgresUrl)('a former paid owner taking the free plan against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_former_paid', 2); });
  afterAll(async () => { await scoped?.close(); });

  it('keeps the paid entitlement when a Stripe reactivation races a former paid owner taking the free plan', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    // Admission is what races; the metal create after it is out of scope here.
    const metal = { provision: async () => ({ error: 'unavailable' as const }) };
    for (let round = 0; round < 5; round += 1) {
      for (const table of ['user_machines', 'free_tier_invites', 'billing_entitlements'] as const) {
        await a.executor.deleteFrom(table).execute();
      }
      await addFreeTierInvite(a, { clerkUserId: OWNER, invitedBy: 'ops' });
      await upsertBillingEntitlement(a, endedPaid());
      const reactivatedAt = new Date().toISOString();
      const provisioner = createFreeRuntimeProvisioner({
        db: a, config: { maxRuntimes: 10, inviteRequired: true }, metal: metal as never, env: {},
      });
      const [outcome] = await Promise.all([
        provisioner.provision({ clerkUserId: OWNER, handle: 'freeowner' }),
        upsertBillingEntitlement(b, { ...endedPaid(), status: 'active', effectiveFrom: reactivatedAt, updatedAt: reactivatedAt }),
      ]);
      expect(['provisioning_unavailable', 'plan_unavailable']).toContain(outcome.kind);
      expect(await getBillingEntitlement(a, OWNER)).toMatchObject({ source: 'stripe', status: 'active' });
    }
  });
});
