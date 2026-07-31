import { describe, expect, it } from 'vitest';
import {
  BILLING_GRACE_PERIOD_MS,
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  computeEffectiveEntitlement,
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  type BillingEntitlement,
  type BillingEntitlementOverride,
} from '../../packages/platform/src/billing.js';

const baseEnv = {
  STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_starter_monthly',
  STRIPE_PRICE_MATRIX_STARTER_ANNUAL: 'price_starter_annual',
  STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder_monthly',
  STRIPE_PRICE_MATRIX_BUILDER_ANNUAL: 'price_builder_annual',
  STRIPE_PRICE_MATRIX_MAX_MONTHLY: 'price_max_monthly',
  STRIPE_PRICE_MATRIX_MAX_ANNUAL: 'price_max_annual',
  STRIPE_PRICE_EXTRA_RUNTIME_MONTHLY: 'price_extra_runtime_monthly',
  STRIPE_PRICE_EXTRA_RUNTIME_ANNUAL: 'price_extra_runtime_annual',
};

describe('platform billing entitlements', () => {
  it('uses marketing plan slugs with monthly and annual prices', () => {
    expect(DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => plan.slug)).toEqual([
      'matrix_starter',
      'matrix_builder',
      'matrix_max',
    ]);
    expect(DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => plan.marketingName)).toEqual([
      'Starter',
      'Builder',
      'Max',
    ]);
    expect(DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => [plan.monthlyUsd, plan.annualUsd])).toEqual([
      [14, 140],
      [19, 190],
      [49, 490],
    ]);
    expect(DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => plan.includedRuntimeSlots)).toEqual([1, 1, 1]);
  });

  it('loads Stripe price ids without trusting client submitted prices', () => {
    const catalog = loadStripePriceCatalog(baseEnv);

    expect(catalog.priceToPlan.get('price_builder_annual')).toMatchObject({
      kind: 'base_plan',
      planSlug: 'matrix_builder',
      interval: 'annual',
    });
    expect(catalog.priceToPlan.has('price_extra_runtime_monthly')).toBe(false);
    expect(catalog.priceToPlan.has('price_unknown')).toBe(false);
  });

  it('keeps Hetzner server types behind a runtime catalog that can be overridden', () => {
    const defaults = loadRuntimeCatalog({});
    expect(defaults.profiles.map((profile) => [profile.sku, profile.serverType])).toEqual([
      ['starter', 'cpx22'],
      ['builder', 'cpx32'],
      ['max', 'cpx52'],
    ]);

    const overridden = loadRuntimeCatalog({
      MATRIX_RUNTIME_CATALOG_JSON: JSON.stringify({
        profiles: [
          {
            sku: 'starter',
            label: 'Starter',
            provider: 'hetzner',
            serverType: 'cx22',
            vcpu: 2,
            memoryGb: 4,
            diskGb: 40,
            active: true,
          },
        ],
      }),
    });

    expect(overridden.profiles).toHaveLength(1);
    expect(overridden.profiles[0]?.serverType).toBe('cx22');
  });

  it('projects one full Stripe plan into exactly one runtime slot', () => {
    const entitlement = deriveStripeEntitlement({
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      status: 'active',
      currentPeriodEnd: '2026-06-30T00:00:00.000Z',
      items: [
        { priceId: 'price_builder_monthly', quantity: 1 },
        { priceId: 'price_extra_runtime_monthly', quantity: 2 },
      ],
    }, {
      priceCatalog: loadStripePriceCatalog(baseEnv),
      runtimeCatalog: loadRuntimeCatalog({}),
      now: new Date('2026-05-30T00:00:00.000Z'),
    });

    expect(entitlement).toMatchObject({
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_builder',
      status: 'active',
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      maxRuntimeSlots: 1,
      defaultServerType: 'cpx32',
      allowedServerTypes: ['cpx22', 'cpx32'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_builder_monthly',
    });
  });

  it('never grants capacity from legacy add-on quantities', () => {
    const entitlement = deriveStripeEntitlement({
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      status: 'active',
      currentPeriodEnd: '2026-06-30T00:00:00.000Z',
      items: [
        { priceId: 'price_builder_monthly', quantity: 1 },
        { priceId: 'price_extra_runtime_monthly', quantity: 0 },
        { priceId: 'price_extra_runtime_monthly' },
      ],
    }, {
      priceCatalog: loadStripePriceCatalog(baseEnv),
      runtimeCatalog: loadRuntimeCatalog({}),
      now: new Date('2026-05-30T00:00:00.000Z'),
    });

    expect(entitlement).toMatchObject({
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      maxRuntimeSlots: 1,
    });
  });

  it('allows runtime access during active billing plus a 3-day grace period', () => {
    const entitlement: BillingEntitlement = {
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_starter',
      status: 'past_due',
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx22',
      allowedServerTypes: ['cpx22'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_starter_monthly',
      gracePeriodEndsAt: '2026-06-03T00:00:00.000Z',
      effectiveFrom: '2026-05-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-05-30T00:00:00.000Z',
    };

    expect(getRuntimeAccessDecision(entitlement, new Date('2026-06-02T23:59:59.000Z'))).toMatchObject({
      runtimeProxyAllowed: true,
      reason: 'grace_period',
    });
    expect(getRuntimeAccessDecision(entitlement, new Date('2026-06-03T00:00:01.000Z'))).toMatchObject({
      runtimeProxyAllowed: false,
      reason: 'payment_required',
    });
  });

  it('prefers unexpired production internal overrides over Stripe state', () => {
    const stripeEntitlement: BillingEntitlement = {
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_starter',
      status: 'past_due',
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx22',
      allowedServerTypes: ['cpx22'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_starter_monthly',
      gracePeriodEndsAt: new Date(Date.parse('2026-05-30T00:00:00.000Z') + BILLING_GRACE_PERIOD_MS).toISOString(),
      effectiveFrom: '2026-05-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-05-30T00:00:00.000Z',
    };
    const override: BillingEntitlementOverride = {
      id: 'override_1',
      clerkUserId: 'user_123',
      planSlug: 'internal',
      status: 'active',
      maxRuntimeSlots: 5,
      includedRuntimeSlots: 5,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx52',
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
      reason: 'engineer test',
      createdBy: 'ops-user',
      expiresAt: '2026-07-01T00:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-05-30T00:00:00.000Z',
    };

    expect(computeEffectiveEntitlement({
      stripeEntitlement,
      override,
      now: new Date('2026-06-10T00:00:00.000Z'),
    })).toMatchObject({
      source: 'override',
      planSlug: 'internal',
      maxRuntimeSlots: 5,
      defaultServerType: 'cpx52',
    });
  });
});
