import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import {
  claimCardTrialCheckoutAttempt,
  claimCheckoutAttempt,
  insertUserMachine,
  upsertBillingEntitlement,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { addFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createFreeRuntimeProvisioner } from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import {
  FREE_UPGRADE_UNAVAILABLE_RESPONSE,
  FreeUpgradeUnavailableError,
} from '../../packages/platform/src/free-tier/free-checkout-guard.js';
import { prepareAiCreditCheckoutClaim } from '../../packages/platform/src/ai-credit-checkout-store.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * Launch guard (spec 2691, ENG-520): free to paid upgrade (ENG-606) does not
 * exist yet, so a free owner must never reach a paid Stripe Checkout. Without
 * the guard a free owner who pays keeps the running free metal machine as the
 * "existing" machine and keeps free limits: a charge with no paid computer.
 * Faults detected: a Stripe call or checkout row for a free owner, a free
 * owner's second paid computer, a free owner admitted between the route check
 * and the claim, and paid, new, or former paid owners losing checkout.
 */

const OWNER = 'user_freeowner';
const NOW = new Date('2026-11-27T12:00:00.000Z');
const env = {
  STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_starter_monthly',
  STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder_monthly',
};

function paidEntitlement(overrides: Partial<BillingEntitlement> = {}): BillingEntitlement {
  return {
    ...buildFreeEntitlement(OWNER, NOW), source: 'stripe', planSlug: 'matrix_starter', status: 'active',
    defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'], stripeSubscriptionId: 'sub_1', stripePriceId: 'price_1',
    ...overrides,
  };
}

describe('POST /billing/checkout for free plan owners', () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;
  let createCheckoutSession: ReturnType<typeof vi.fn>;
  let stripeCalls: string[];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb({ serializeTransactions: true }));
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    stripeCalls = [];
    createCheckoutSession = vi.fn(async () => ({ url: 'https://checkout.stripe.test/session', id: 'cs_test' }));
    stripe = new Proxy({ apiTimeoutMs: 10_000 } as Record<string, unknown>, {
      get(target, key) {
        if (key === 'apiTimeoutMs') return target.apiTimeoutMs;
        if (key === 'createCheckoutSession') {
          return (...args: unknown[]) => { stripeCalls.push('createCheckoutSession'); return createCheckoutSession(...args); };
        }
        if (typeof key === 'string') return () => { stripeCalls.push(key); throw new Error(`unexpected stripe ${key}`); };
        return undefined;
      },
    }) as unknown as StripeBillingClient;
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function app() {
    const routes = new Hono();
    routes.route('/billing', createBillingRoutes({
      db, stripe, env, resolveClerkUserId: async () => OWNER, now: () => NOW,
    }));
    return routes;
  }

  function checkout(runtimeSlot?: string) {
    return app().request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder', interval: 'monthly', regionSlug: 'region_nbg1',
        ...(runtimeSlot ? { runtimeSlot } : {}),
      }),
    });
  }

  async function freeOwnerWithRunningMetal() {
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
    await insertUserMachine(db, {
      machineId: 'metal-1', clerkUserId: OWNER, handle: 'freeowner', status: 'running',
      provisionedAt: NOW.toISOString(), substrate: 'metal', metalHostId: 'host-a',
    });
  }

  async function checkoutWrites() {
    const [attempts, trials, attribution] = await Promise.all([
      db.executor.selectFrom('billing_checkout_attempts').select('id').execute(),
      db.executor.selectFrom('billing_trial_accounts').select('clerk_user_id').execute(),
      db.executor.selectFrom('billing_google_checkout_attribution').selectAll().execute(),
    ]);
    return { attempts: attempts.length, trials: trials.length, attribution: attribution.length };
  }

  async function expectRefused(response: Response) {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'free_upgrade_unavailable',
      error: 'Upgrades for free computers are coming soon.',
    });
  }

  it('refuses a free owner before any Stripe call or checkout write, with a generic body', async () => {
    await freeOwnerWithRunningMetal();
    await expectRefused(await checkout());
    expect(stripeCalls).toEqual([]);
    expect(await checkoutWrites()).toEqual({ attempts: 0, trials: 0, attribution: 0 });
    expect(FREE_UPGRADE_UNAVAILABLE_RESPONSE).toEqual({
      code: 'free_upgrade_unavailable', error: 'Upgrades for free computers are coming soon.',
    });
  });

  it('refuses a free owner adding a second paid computer (deliberate launch restriction)', async () => {
    await freeOwnerWithRunningMetal();
    await expectRefused(await checkout('studio'));
    expect(stripeCalls).toEqual([]);
    expect(await checkoutWrites()).toEqual({ attempts: 0, trials: 0, attribution: 0 });
  });

  it('refuses an admitted free owner whose metal computer is not built yet', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
    await expectRefused(await checkout());
    expect(stripeCalls).toEqual([]);
  });

  it('refuses an owner with a live metal computer in the free slot even without a stored free entitlement', async () => {
    await insertUserMachine(db, {
      machineId: 'metal-1', clerkUserId: OWNER, handle: 'freeowner', status: 'running',
      provisionedAt: NOW.toISOString(), substrate: 'metal', metalHostId: 'host-a',
    });
    await expectRefused(await checkout());
    expect(stripeCalls).toEqual([]);
  });

  it('refuses every concurrent double click and writes nothing', async () => {
    await freeOwnerWithRunningMetal();
    const responses = await Promise.all([checkout(), checkout(), checkout('studio')]);
    for (const response of responses) await expectRefused(response);
    expect(stripeCalls).toEqual([]);
    expect(await checkoutWrites()).toEqual({ attempts: 0, trials: 0, attribution: 0 });
  });

  it('refuses inside the owner lock when the owner became free after the route check', async () => {
    // The route reads free status before claiming; free admission may commit in
    // between. Both claim paths re-check under the owner lock they share with it.
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
    const claim = {
      id: 'att-1', clerkUserId: OWNER, runtimeSlot: 'primary', planSlug: 'matrix_builder' as const,
      billingInterval: 'monthly' as const, regionSlug: 'region_nbg1', createdAt: NOW.toISOString(),
    };
    await expect(claimCardTrialCheckoutAttempt(db, claim, null)).rejects.toBeInstanceOf(FreeUpgradeUnavailableError);
    await expect(claimCheckoutAttempt(db, { ...claim, id: 'att-2', runtimeSlot: 'studio' }))
      .rejects.toBeInstanceOf(FreeUpgradeUnavailableError);
    expect(await checkoutWrites()).toEqual({ attempts: 0, trials: 0, attribution: 0 });
  });

  it('leaves checkout unchanged for an owner with no runtime', async () => {
    const response = await checkout();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('leaves checkout unchanged for a paid owner adding a computer', async () => {
    await upsertBillingEntitlement(db, paidEntitlement());
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: OWNER, handle: 'paidowner', status: 'running',
      provisionedAt: NOW.toISOString(),
    });
    const response = await checkout('studio');
    expect(response.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ clerkUserId: OWNER, runtimeSlot: 'studio' }));
  });

  it('leaves checkout unchanged for a former paid owner who has not taken the free plan', async () => {
    await upsertBillingEntitlement(db, paidEntitlement({ status: 'canceled' }));
    const response = await checkout();
    expect(response.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  describe('joining the free plan with a paid checkout in another slot', () => {
    // Free admission must see a pending paid checkout in any slot, not only the
    // free slot: otherwise a 'studio' checkout claimed first survives the owner
    // joining free and Stripe charges a free owner.
    const studioClaim = {
      id: 'att-studio', clerkUserId: OWNER, runtimeSlot: 'studio', planSlug: 'matrix_builder' as const,
      billingInterval: 'monthly' as const, regionSlug: 'region_nbg1',
    };
    function provisioner() {
      return createFreeRuntimeProvisioner({
        db, config: { maxRuntimes: 10, inviteRequired: true }, env: {}, now: () => new Date(),
        metal: { provision: async () => ({ error: 'unavailable' as const }) } as never,
      });
    }
    async function storedSource() {
      return (await db.executor.selectFrom('billing_entitlements').select('source')
        .where('clerk_user_id', '=', OWNER).executeTakeFirst())?.source ?? null;
    }

    beforeEach(async () => { await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' }); });

    it('refuses to join while a second-slot paid checkout is being created or open', async () => {
      const claimed = await claimCheckoutAttempt(db, { ...studioClaim, createdAt: new Date().toISOString() });
      expect(claimed.claimed).toBe(true);
      expect((await provisioner().provision({ clerkUserId: OWNER, handle: 'freeowner' })).kind).toBe('checkout_pending');
      expect(await provisioner().isEligible(OWNER)).toBe(false);
      expect(await storedSource()).toBeNull();
    });

    it('refuses the second-slot claim once the owner has joined', async () => {
      await provisioner().provision({ clerkUserId: OWNER, handle: 'freeowner' });
      expect(await storedSource()).toBe('free');
      await expect(claimCheckoutAttempt(db, { ...studioClaim, createdAt: new Date().toISOString() }))
        .rejects.toBeInstanceOf(FreeUpgradeUnavailableError);
      expect(await checkoutWrites()).toMatchObject({ attempts: 0 });
    });

    it('never lets both a concurrent join and a second-slot claim win', async () => {
      for (let round = 0; round < 5; round += 1) {
        await db.executor.deleteFrom('billing_checkout_attempts').execute();
        await db.executor.deleteFrom('user_machines').execute();
        await db.executor.deleteFrom('billing_entitlements').execute();
        await db.executor.deleteFrom('free_tier_invites').execute();
        await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
        const [joined, claim] = await Promise.allSettled([
          provisioner().provision({ clerkUserId: OWNER, handle: 'freeowner' }),
          claimCheckoutAttempt(db, { ...studioClaim, id: `att-${round}`, createdAt: new Date().toISOString() }),
        ]);
        const free = (await storedSource()) === 'free';
        const claimWon = claim.status === 'fulfilled' && claim.value.claimed;
        expect(free && claimWon).toBe(false);
        expect(free || claimWon).toBe(true);
        if (!claimWon) expect(claim.status === 'rejected' && claim.reason).toBeInstanceOf(FreeUpgradeUnavailableError);
        if (!free) expect(joined.status === 'fulfilled' && joined.value.kind).toBe('checkout_pending');
      }
    });
  });

  describe('POST /billing/ai-credit/checkout', () => {
    // Hamed, 2026-11-27: no AI credit purchases for free owners until purchased
    // credit is verified on the free funding path.
    const creditEnv = {
      MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'configured',
      STRIPE_PRICE_AI_CREDIT_USD_5: 'price_ai_5', STRIPE_PRICE_AI_CREDIT_USD_10: 'price_ai_10',
      STRIPE_PRICE_AI_CREDIT_USD_25: 'price_ai_25',
    };
    const fundedAiRepository = new Proxy({}, {
      get: (_target, key) => () => { throw new Error(`unexpected funded repository ${String(key)}`); },
    }) as never;

    function buyCredit() {
      const routes = new Hono();
      routes.route('/billing', createBillingRoutes({
        db, stripe, env: creditEnv, resolveClerkUserId: async () => OWNER, now: () => NOW, fundedAiRepository,
      }));
      return routes.request('/billing/ai-credit/checkout', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageId: 'usd_5', runtimeSlot: 'primary', requestId: crypto.randomUUID() }),
      });
    }
    async function creditClaims() {
      return (await db.executor.selectFrom('ai_credit_checkout_claims').select('request_id').execute()).length;
    }

    it('refuses a free owner before any Stripe call or claim write, with a generic body', async () => {
      await freeOwnerWithRunningMetal();
      await db.executor.updateTable('user_machines').set({ activation_state: 'authorized' }).execute();
      const response = await buyCredit();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: 'free_upgrade_unavailable', error: 'AI credit for free computers is coming soon.',
      });
      expect(stripeCalls).toEqual([]);
      expect(await creditClaims()).toBe(0);
    });

    it('refuses the claim under the owner lock when the owner became free after the route check', async () => {
      await freeOwnerWithRunningMetal();
      await db.executor.updateTable('user_machines').set({ activation_state: 'authorized' }).execute();
      await expect(prepareAiCreditCheckoutClaim(db, {
        requestId: crypto.randomUUID(), ownerId: OWNER, machineId: 'metal-1', runtimeSlot: 'primary',
        packageId: 'usd_5', priceId: 'price_ai_5', amountMicrousd: 5_000_000, amountCents: 500, currency: 'usd',
        automaticTax: false, idempotencyKey: 'matrix-ai-credit:test',
      }, NOW)).rejects.toBeInstanceOf(FreeUpgradeUnavailableError);
      expect(await creditClaims()).toBe(0);
    });
  });
});
