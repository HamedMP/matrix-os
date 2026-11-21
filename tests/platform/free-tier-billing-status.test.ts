import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import {
  getAccessibleRunningUserMachineByClerkIdForUpdate,
  insertCheckoutAttempt,
  insertUserMachine,
  upsertBillingEntitlement,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { addFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createFreeRuntimeProvisioner } from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import { createJourneyRoutes } from '../../packages/platform/src/journey-routes.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * Billing status for the free plan on metal (spec 2691, ENG-520). BillingGate
 * (web device flow behind `matrix login`, `?plans`, `?checkout`) and the
 * native apps read `access.runtimeProxyAllowed` from `/billing/status`; an
 * owner who can take the free plan must pass that gate instead of seeing paid
 * plans. Faults detected: an invited or admitted free owner sent to checkout,
 * an uninvited owner shown as having access, a paid status changed by the free
 * tier, and a CLI login that never reaches a running free computer.
 */

const OWNER = 'user_freeowner';
const NOW = new Date('2026-11-21T12:00:00.000Z');

const unusedStripe = new Proxy({ apiTimeoutMs: 10_000 }, {
  get(target, key) {
    if (key in target) return target[key as keyof typeof target];
    return () => { throw new Error('stripe must not be called'); };
  },
}) as unknown as StripeBillingClient;

function paidEntitlement(overrides: Partial<BillingEntitlement> = {}): BillingEntitlement {
  return {
    ...buildFreeEntitlement(OWNER, NOW), source: 'stripe', planSlug: 'matrix_starter', status: 'active',
    defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'], stripeSubscriptionId: 'sub_1', stripePriceId: 'price_1',
    ...overrides,
  };
}

describe('/billing/status for the free plan on metal', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function freeProvisioner() {
    return createFreeRuntimeProvisioner({
      db, config: { maxRuntimes: 10, inviteRequired: true }, env: {},
      metal: { provision: async () => { throw new Error('status must not provision'); } },
    });
  }

  async function status(options: { freeTier?: boolean; path?: string } = {}) {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db, stripe: unusedStripe, env: {}, resolveClerkUserId: async () => OWNER, now: () => NOW,
      ...(options.freeTier === false ? {} : { resolveFreePlanEligibility: freeProvisioner().isEligible }),
    }));
    const response = await app.request(options.path ?? '/billing/status?runtimeSlot=primary&trialOfferVersion=2');
    expect(response.status).toBe(200);
    return (await response.json()) as { access: { runtimeProxyAllowed: boolean; reason: string } };
  }

  it('grants access to an invited free owner so the gate lets them through', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    for (const path of ['/billing/status', '/billing/status?runtimeSlot=primary&trialOfferVersion=2']) {
      expect((await status({ path })).access).toMatchObject({ runtimeProxyAllowed: true, reason: 'active' });
    }
  });

  it('grants access to an admitted free owner whose metal VM is not built yet or failed', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
    expect((await status()).access.runtimeProxyAllowed).toBe(true);
    await insertUserMachine(db, {
      machineId: 'metal-1', clerkUserId: OWNER, handle: 'freeowner', status: 'failed',
      provisionedAt: NOW.toISOString(), substrate: 'metal', metalHostId: 'host-a',
    });
    expect((await status()).access.runtimeProxyAllowed).toBe(true);
  });

  it('does not report free access while a paid checkout is settling', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await insertCheckoutAttempt(db, { id: 'att-1', clerkUserId: OWNER, stripeSessionId: 'cs_open', createdAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await status()).access.runtimeProxyAllowed).toBe(false);
  });

  it('does not report free access while an older paid checkout session is still open', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await insertCheckoutAttempt(db, { id: 'att-old', clerkUserId: OWNER, stripeSessionId: 'cs_open_old', createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
    expect((await status()).access.runtimeProxyAllowed).toBe(false);
  });

  it('keeps an uninvited owner on billing required', async () => {
    expect((await status()).access).toMatchObject({ runtimeProxyAllowed: false, reason: 'no_entitlement' });
  });

  it('ignores invites while the free tier is off', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    expect((await status({ freeTier: false })).access.runtimeProxyAllowed).toBe(false);
  });

  it('leaves paid status unchanged, and never grants a lapsed paid owner free access', async () => {
    await upsertBillingEntitlement(db, paidEntitlement());
    const paid = await status({ path: '/billing/status' });
    const paidWithoutFreeTier = await status({ path: '/billing/status', freeTier: false });
    expect(paid).toEqual(paidWithoutFreeTier);
    expect(paid.access.runtimeProxyAllowed).toBe(true);

    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, paidEntitlement({ status: 'canceled' }));
    expect((await status({ path: '/billing/status' })).access.runtimeProxyAllowed).toBe(false);
  });

  it('the CLI login path for a free owner proceeds to a computer the device flow can approve', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    // 1. matrix login opens the browser device flow; BillingGate reads billing status first.
    expect((await status()).access.runtimeProxyAllowed).toBe(true);
    // 2. BootSequence then follows the journey, which starts the free build.
    const journey = createJourneyRoutes({
      db, resolveUserId: async () => OWNER, appOrigin: 'https://app.matrix-os.com', env: {}, maxProvisionAttempts: 3,
      now: () => NOW, resolveFreePlanEligibility: freeProvisioner().isEligible,
      provisionRuntime: async () => {
        await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
        await insertUserMachine(db, {
          machineId: 'metal-1', clerkUserId: OWNER, handle: 'freeowner', status: 'provisioning',
          provisionedAt: NOW.toISOString(), substrate: 'metal', metalHostId: 'host-a',
        });
      },
    });
    expect(await (await journey.request('/api/journey')).json()).toMatchObject({ phase: 'install_choices_required' });
    const started = await journey.request('/api/journey/retry-provision', { method: 'POST', body: '{}' });
    expect(await started.json()).toMatchObject({ status: 'started', journey: { phase: 'provisioning' } });
    // 3. Once the guest registers, the device approval target resolves to the free computer.
    await db.executor.updateTable('user_machines').set({ status: 'running' }).where('machine_id', '=', 'metal-1').execute();
    const target = await db.transaction((trx) => getAccessibleRunningUserMachineByClerkIdForUpdate(trx, OWNER, 'primary'));
    expect(target).toMatchObject({ handle: 'freeowner', substrate: 'metal' });
    expect((await status()).access.runtimeProxyAllowed).toBe(true);
  });
});
