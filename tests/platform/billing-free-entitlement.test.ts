import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MATRIX_FREE_PLAN,
  MATRIX_FREE_PLAN_SLUG,
  MATRIX_HOSTED_BILLING_PLAN_SLUGS,
  MatrixBillingPublicEntitlementSchema,
} from '@matrix-os/contracts';
import {
  computeEffectiveEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  parseBillingEntitlementRecord,
  parseBillingOverrideRecord,
  projectPublicBillingEntitlement,
  type BillingEntitlement,
} from '../../packages/platform/src/billing.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { resolveEffectiveBillingEntitlementForSlot } from '../../packages/platform/src/billing-entitlement-resolver.js';
import { insertUserMachine, upsertBillingEntitlement, type PlatformDB } from '../../packages/platform/src/db.js';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const NOW = new Date('2026-11-11T10:00:00.000Z');

function paidEntitlement(overrides: Partial<BillingEntitlement> = {}): BillingEntitlement {
  return {
    clerkUserId: 'user_paid', source: 'stripe', planSlug: 'matrix_starter', status: 'active',
    maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0,
    defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'],
    stripeSubscriptionId: 'sub_1', stripePriceId: 'price_1', billingInterval: 'monthly',
    gracePeriodEndsAt: null, effectiveFrom: NOW.toISOString(), effectiveUntil: null, updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const PRICE_ENV = { STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_1' };

async function insertSubscription(db: PlatformDB, clerkUserId: string, changes: {
  status: string; gracePeriodEndsAt?: string | null; currentPeriodEnd?: string | null; id?: string;
}) {
  await db.executor.insertInto('billing_subscriptions').values({
    stripe_subscription_id: changes.id ?? 'sub_old', stripe_customer_id: 'cus_1', clerk_user_id: clerkUserId,
    runtime_slot: 'primary', plan_slug: 'matrix_starter', stripe_price_id: 'price_1', billing_interval: 'monthly',
    price_unit_amount_minor: null, price_currency: null, price_interval_count: null, price_quantity: null,
    status: changes.status, current_period_end: changes.currentPeriodEnd ?? null,
    grace_period_ends_at: changes.gracePeriodEndsAt ?? null, trial_started_at: null, trial_ends_at: null,
    trial_converted_at: null, first_trial_payment_failed_at: null, latest_event_created_at: '2026-10-01T00:00:00.000Z',
    latest_event_id: `evt_${changes.id ?? 'old'}`, latest_invoice_event_created_at: null, latest_invoice_event_id: null,
    updated_at: '2026-10-01T00:00:00.000Z',
  } as never).execute();
}

describe('free plan catalog', () => {
  it('defines a zero-cost plan for one container runtime that checkout cannot sell', () => {
    expect(MATRIX_FREE_PLAN).toMatchObject({ slug: 'matrix_free', monthlyUsd: 0, maxRuntimeSlots: 1, substrate: 'container' });
    expect(MATRIX_HOSTED_BILLING_PLAN_SLUGS).not.toContain(MATRIX_FREE_PLAN_SLUG);
  });
});

describe('free entitlement access decisions', () => {
  const free = buildFreeEntitlement('user_free', NOW);

  it('grants one container runtime with no VPS server types and no Stripe linkage', () => {
    expect(free).toMatchObject({
      source: 'free', planSlug: 'matrix_free', status: 'active', maxRuntimeSlots: 1,
      includedRuntimeSlots: 1, allowedServerTypes: [], defaultServerType: '',
      stripeSubscriptionId: null, stripePriceId: null, gracePeriodEndsAt: null,
    });
  });

  it('allows a container runtime without checkout', () => {
    expect(getRuntimeAccessDecision(free, NOW, 'container')).toEqual({
      runtimeProxyAllowed: true, reason: 'active', gracePeriodEndsAt: null,
    });
  });

  it('never allows a VPS, and fails closed when the caller names no substrate', () => {
    expect(getRuntimeAccessDecision(free, NOW, 'vps')).toEqual({ runtimeProxyAllowed: false, reason: 'no_entitlement' });
    expect(getRuntimeAccessDecision(free, NOW)).toEqual({ runtimeProxyAllowed: false, reason: 'no_entitlement' });
  });

  it('denies an inactive free entitlement even for a container', () => {
    expect(getRuntimeAccessDecision({ ...free, status: 'canceled' }, NOW, 'container').runtimeProxyAllowed).toBe(false);
  });

  it('leaves paid decisions unchanged whatever substrate is named', () => {
    const paid = paidEntitlement();
    const expected = getRuntimeAccessDecision(paid, NOW);
    expect(expected).toMatchObject({ runtimeProxyAllowed: true, reason: 'active' });
    expect(getRuntimeAccessDecision(paid, NOW, 'vps')).toEqual(expected);
    const lapsed = paidEntitlement({ status: 'canceled', gracePeriodEndsAt: '2026-11-01T00:00:00.000Z' });
    expect(getRuntimeAccessDecision(lapsed, NOW, 'vps')).toEqual(getRuntimeAccessDecision(lapsed, NOW));
    expect(getRuntimeAccessDecision(null, NOW, 'container')).toEqual({ runtimeProxyAllowed: false, reason: 'no_entitlement' });
  });

  it('lets an operator override still win over a stored free entitlement', () => {
    const effective = computeEffectiveEntitlement({
      stripeEntitlement: free,
      override: {
        id: 'ovr_1', clerkUserId: 'user_free', planSlug: 'internal', status: 'active', maxRuntimeSlots: 1,
        includedRuntimeSlots: 1, addonRuntimeSlots: 0, defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'],
        reason: 'support', createdBy: 'operator', expiresAt: null, revokedAt: null, createdAt: NOW.toISOString(),
      },
      now: NOW,
    });
    expect(effective?.source).toBe('override');
  });
});

describe('stored free entitlement records', () => {
  const record = { ...buildFreeEntitlement('user_free', NOW) };

  it('round-trips a free record', () => {
    expect(parseBillingEntitlementRecord(record)).toMatchObject({ source: 'free', planSlug: 'matrix_free' });
  });

  it('rejects a free plan paired with a paid source or a paid plan paired with the free source', () => {
    expect(parseBillingEntitlementRecord({ ...record, source: 'stripe' })).toBeNull();
    expect(parseBillingEntitlementRecord({ ...record, planSlug: 'matrix_max' })).toBeNull();
  });

  it('rejects an operator override that names the free plan', () => {
    expect(parseBillingOverrideRecord({
      id: 'ovr_free', clerkUserId: 'user_free', planSlug: 'matrix_free', status: 'active', maxRuntimeSlots: 1,
      includedRuntimeSlots: 1, addonRuntimeSlots: 0, defaultServerType: '', allowedServerTypes: [],
      reason: 'x', createdBy: 'operator', expiresAt: null, revokedAt: null, createdAt: NOW.toISOString(),
    })).toBeNull();
  });

  it('projects publicly with no VPS selections', () => {
    const projected = projectPublicBillingEntitlement(buildFreeEntitlement('user_free', NOW), loadRuntimeCatalog({}));
    expect(MatrixBillingPublicEntitlementSchema.parse(projected)).toMatchObject({
      source: 'free', planSlug: 'matrix_free', allowedPlanSlugs: [], allowedSelections: [], maxRuntimeSlots: 1,
    });
  });
});

describe('slot-scoped entitlement resolution', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('resolves a stored free entitlement for the primary slot when no subscription exists', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement('user_free', NOW));
    const primary = await resolveEffectiveBillingEntitlementForSlot(db, 'user_free', NOW, 'primary', {});
    expect(primary).toMatchObject({ source: 'free', planSlug: 'matrix_free' });
    expect(await resolveEffectiveBillingEntitlementForSlot(db, 'user_free', NOW, 'secondary', {})).toBeNull();
  });

  it('resolves the free entitlement for a former paid owner whose ended primary subscription is retained', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement('user_free', NOW));
    await insertSubscription(db, 'user_free', { status: 'canceled' });
    const primary = await resolveEffectiveBillingEntitlementForSlot(db, 'user_free', NOW, 'primary', PRICE_ENV);
    expect(primary).toMatchObject({ source: 'free', planSlug: 'matrix_free' });
    expect(getRuntimeAccessDecision(primary, NOW, 'container')).toMatchObject({ runtimeProxyAllowed: true });
  });

  it('resolves a resubscribed former free owner to the live paid subscription', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement('user_free', NOW));
    await insertSubscription(db, 'user_free', { status: 'active', id: 'sub_new' });
    expect(await resolveEffectiveBillingEntitlementForSlot(db, 'user_free', NOW, 'primary', PRICE_ENV))
      .toMatchObject({ source: 'stripe', status: 'active', stripeSubscriptionId: 'sub_new' });
  });

  it.each(['active', 'canceled', 'past_due'])('leaves a paid owner with a %s subscription on the subscription', async (status) => {
    await upsertBillingEntitlement(db, paidEntitlement());
    await insertSubscription(db, 'user_paid', { status });
    expect(await resolveEffectiveBillingEntitlementForSlot(db, 'user_paid', NOW, 'primary', PRICE_ENV))
      .toMatchObject({ source: 'stripe', status, stripeSubscriptionId: 'sub_old' });
  });

  it('still ignores a stored paid entitlement for a slot without a subscription', async () => {
    await upsertBillingEntitlement(db, paidEntitlement());
    expect(await resolveEffectiveBillingEntitlementForSlot(db, 'user_paid', NOW, 'primary', {})).toBeNull();
    expect(await resolveEffectiveBillingEntitlementForSlot(db, 'user_paid', NOW, undefined, {}))
      .toMatchObject({ source: 'stripe', planSlug: 'matrix_starter' });
  });
});

describe('billing status for a free owner', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  const unusedStripe = new Proxy({ apiTimeoutMs: 10_000 }, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return () => { throw new Error('stripe must not be called'); };
    },
  }) as unknown as StripeBillingClient;

  function status(path: string) {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db, stripe: unusedStripe, env: PRICE_ENV, resolveClerkUserId: async () => 'user_free', now: () => NOW,
    }));
    return app.request(path);
  }

  it('lets an active free owner through to their container runtime instead of the payment gate', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement('user_free', NOW));
    await insertUserMachine(db, {
      machineId: 'ctr-free', clerkUserId: 'user_free', handle: 'freeowner', status: 'stopped',
      provisionedAt: NOW.toISOString(), substrate: 'container',
    });
    for (const path of ['/billing/status', '/billing/status?runtimeSlot=primary']) {
      const response = await status(path);
      expect(response.status).toBe(200);
      expect((await response.json()).access).toMatchObject({ runtimeProxyAllowed: true, reason: 'active' });
    }
  });

  it('lets a former paid free owner through although their ended primary subscription is retained', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement('user_free', NOW));
    await insertSubscription(db, 'user_free', { status: 'canceled' });
    await insertUserMachine(db, {
      machineId: 'ctr-free', clerkUserId: 'user_free', handle: 'freeowner', status: 'stopped',
      provisionedAt: NOW.toISOString(), substrate: 'container',
    });
    for (const path of ['/billing/status', '/billing/status?runtimeSlot=primary']) {
      const response = await status(path);
      expect(response.status).toBe(200);
      expect((await response.json()).access).toMatchObject({ runtimeProxyAllowed: true, reason: 'active' });
    }
  });

  it('still refuses a free owner whose runtime is a VPS', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement('user_free', NOW));
    await insertUserMachine(db, {
      machineId: 'vps-free', clerkUserId: 'user_free', handle: 'freeowner', status: 'running',
      provisionedAt: NOW.toISOString(),
    });
    const response = await status('/billing/status?runtimeSlot=primary');
    expect((await response.json()).access).toMatchObject({ runtimeProxyAllowed: false });
  });
});
