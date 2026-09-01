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
  it('uses the new monthly hosted prices while retaining annual catalog recognition', () => {
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
    expect(DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => plan.monthlyUsd)).toEqual([
      20,
      100,
      200,
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

  it('recognizes grandfathered monthly and annual Stripe prices after new prices are configured', () => {
    const catalog = loadStripePriceCatalog({
      ...baseEnv,
      STRIPE_LEGACY_PRICE_CATALOG_JSON: JSON.stringify([
        { priceId: 'price_old_starter_monthly', planSlug: 'matrix_starter', interval: 'monthly' },
        { priceId: 'price_old_builder_annual', planSlug: 'matrix_builder', interval: 'annual' },
      ]),
    });

    expect(catalog.priceToPlan.get('price_old_starter_monthly')).toEqual({
      kind: 'base_plan', planSlug: 'matrix_starter', interval: 'monthly',
    });
    expect(catalog.priceToPlan.get('price_old_builder_annual')).toEqual({
      kind: 'base_plan', planSlug: 'matrix_builder', interval: 'annual',
    });
    expect(catalog.priceToPlan.get('price_builder_monthly')).toEqual({
      kind: 'base_plan', planSlug: 'matrix_builder', interval: 'monthly',
    });
  });

  it('keeps Hetzner server types behind a runtime catalog that can be overridden', () => {
    const defaults = loadRuntimeCatalog({});
    expect(defaults.profiles.map((profile) => [profile.regionSlug, profile.sku, profile.serverType])).toEqual([
      ['region_fsn1', 'starter', 'cpx22'],
      ['region_fsn1', 'builder', 'cpx42'],
      ['region_fsn1', 'max', 'cpx52'],
      ['region_nbg1', 'starter', 'cpx22'],
      ['region_nbg1', 'builder', 'cpx42'],
      ['region_nbg1', 'max', 'cpx52'],
      ['region_ash', 'starter', 'cpx21'],
      ['region_ash', 'builder', 'cpx31'],
      ['region_ash', 'max', 'cpx41'],
      ['region_hil', 'starter', 'cpx21'],
      ['region_hil', 'builder', 'cpx31'],
      ['region_hil', 'max', 'cpx41'],
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
      defaultServerType: 'cpx42',
      allowedServerTypes: ['cpx22', 'cpx21', 'cpx42', 'cpx31'],
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

  it('gates the first failed post-trial charge without applying renewal grace', () => {
    const entitlement = deriveStripeEntitlement({
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_trial',
      status: 'past_due',
      currentPeriodEnd: '2026-06-06T00:00:00.000Z',
      trialStartedAt: '2026-05-30T00:00:00.000Z',
      trialEndsAt: '2026-06-06T00:00:00.000Z',
      trialConvertedAt: null,
      firstTrialPaymentFailedAt: '2026-06-06T00:05:00.000Z',
      items: [{ priceId: 'price_builder_monthly', quantity: 1 }],
    }, {
      priceCatalog: loadStripePriceCatalog(baseEnv),
      runtimeCatalog: loadRuntimeCatalog({}),
      now: new Date('2026-06-06T00:05:00.000Z'),
    });

    expect(entitlement).toMatchObject({
      trialEndsAt: '2026-06-06T00:00:00.000Z',
      trialConvertedAt: null,
      firstTrialPaymentFailedAt: '2026-06-06T00:05:00.000Z',
      gracePeriodEndsAt: null,
    });
    expect(getRuntimeAccessDecision(entitlement, new Date('2026-06-06T00:05:01.000Z'))).toEqual({
      runtimeProxyAllowed: false,
      reason: 'payment_required',
      gracePeriodEndsAt: null,
    });
  });

  it('keeps a canceled trial accessible until Stripe trial_end', () => {
    const entitlement = deriveStripeEntitlement({
      clerkUserId: 'user_123', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_trial',
      status: 'canceled', currentPeriodEnd: '2026-06-06T00:00:00.000Z',
      trialStartedAt: '2026-05-30T00:00:00.000Z', trialEndsAt: '2026-06-06T00:00:00.000Z',
      trialConvertedAt: null, firstTrialPaymentFailedAt: null,
      items: [{ priceId: 'price_builder_monthly', quantity: 1 }],
    }, {
      priceCatalog: loadStripePriceCatalog(baseEnv), runtimeCatalog: loadRuntimeCatalog({}),
      now: new Date('2026-05-31T00:00:00.000Z'),
    });

    expect(getRuntimeAccessDecision(entitlement, new Date('2026-06-05T23:59:59.000Z'))).toMatchObject({
      runtimeProxyAllowed: true,
    });
    expect(getRuntimeAccessDecision(entitlement, new Date('2026-06-06T00:00:00.000Z'))).toMatchObject({
      runtimeProxyAllowed: false,
      reason: 'payment_required',
    });
  });

  it('gates a still-trialing projection at trial_end until conversion is verified', () => {
    const entitlement = deriveStripeEntitlement({
      clerkUserId: 'user_123', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_trial',
      status: 'trialing', currentPeriodEnd: '2026-06-06T00:00:00.000Z',
      trialStartedAt: '2026-05-30T00:00:00.000Z', trialEndsAt: '2026-06-06T00:00:00.000Z',
      trialConvertedAt: null, firstTrialPaymentFailedAt: null,
      items: [{ priceId: 'price_builder_monthly', quantity: 1 }],
    }, {
      priceCatalog: loadStripePriceCatalog(baseEnv), runtimeCatalog: loadRuntimeCatalog({}),
      now: new Date('2026-06-06T00:00:00.000Z'),
    });

    expect(getRuntimeAccessDecision(entitlement, new Date('2026-06-05T23:59:59.000Z'))).toMatchObject({
      runtimeProxyAllowed: true,
    });
    expect(getRuntimeAccessDecision(entitlement, new Date('2026-06-06T00:00:00.000Z'))).toEqual({
      runtimeProxyAllowed: false,
      reason: 'payment_required',
      gracePeriodEndsAt: null,
    });
  });

  it('keeps renewal grace after a trial has converted', () => {
    const entitlement = deriveStripeEntitlement({
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_trial',
      status: 'past_due',
      currentPeriodEnd: '2026-07-06T00:00:00.000Z',
      trialStartedAt: '2026-05-30T00:00:00.000Z',
      trialEndsAt: '2026-06-06T00:00:00.000Z',
      trialConvertedAt: '2026-06-06T00:01:00.000Z',
      firstTrialPaymentFailedAt: null,
      items: [{ priceId: 'price_builder_monthly', quantity: 1 }],
    }, {
      priceCatalog: loadStripePriceCatalog(baseEnv),
      runtimeCatalog: loadRuntimeCatalog({}),
      now: new Date('2026-07-06T00:05:00.000Z'),
    });

    expect(entitlement.gracePeriodEndsAt).toBe('2026-07-09T00:00:00.000Z');
    expect(getRuntimeAccessDecision(entitlement, new Date('2026-07-07T00:00:00.000Z')).runtimeProxyAllowed).toBe(true);
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
