import { describe, expect, it, vi } from 'vitest';
import {
  createStripeBillingClient,
  MATRIX_STRIPE_API_TIMEOUT_MS,
  MATRIX_STRIPE_API_VERSION,
} from '../../packages/platform/src/stripe-billing.js';

describe('platform/stripe-billing', () => {
  it('creates subscription checkout sessions with tax and promotion-code support', async () => {
    const sessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session' });
    const stripe = fakeStripe({
      checkout: { sessions: { create: sessionsCreate } },
    });
    const client = createStripeBillingClient({ secretKey: 'sk_test_123', stripe });

    expect(client.apiTimeoutMs).toBe(MATRIX_STRIPE_API_TIMEOUT_MS);
    await expect(client.createCheckoutSession({
      clerkUserId: 'user_123',
      customerId: 'cus_123',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_nbg1',
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });

    expect(sessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_123',
      client_reference_id: 'user_123',
      line_items: [{ price: 'price_builder_monthly', quantity: 1 }],
      success_url: 'https://app.matrix-os.com/?checkout=success',
      cancel_url: 'https://app.matrix-os.com/?billing=canceled',
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      metadata: {
        clerk_user_id: 'user_123',
        matrix_region_slug: 'region_nbg1',
      },
      subscription_data: {
        metadata: {
          clerk_user_id: 'user_123',
          matrix_region_slug: 'region_nbg1',
        },
      },
      tax_id_collection: { enabled: true },
      customer_update: {
        address: 'auto',
        name: 'auto',
      },
    });
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('payment_method_types');
  });

  it('creates checkout sessions without customer-write permission when no customer exists yet', async () => {
    const sessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session' });
    const stripe = fakeStripe({
      checkout: { sessions: { create: sessionsCreate } },
    });
    const client = createStripeBillingClient({ secretKey: 'sk_test_123', stripe });

    await expect(client.createCheckoutSession({
      clerkUserId: 'user_123',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_nbg1',
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('customer');
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('customer_update');
    expect(sessionsCreate.mock.calls[0]?.[0]).toMatchObject({
      client_reference_id: 'user_123',
      metadata: { clerk_user_id: 'user_123' },
      subscription_data: { metadata: { clerk_user_id: 'user_123' } },
    });
  });

  it('creates portal sessions with a platform return URL', async () => {
    const portalCreate = vi.fn().mockResolvedValue({ url: 'https://billing.stripe.test/session' });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ billingPortal: { sessions: { create: portalCreate } } }),
    });

    await expect(client.createPortalSession({
      customerId: 'cus_123',
      returnUrl: 'https://app.matrix-os.com/?billing=portal',
    })).resolves.toEqual({ url: 'https://billing.stripe.test/session' });
    expect(portalCreate).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'https://app.matrix-os.com/?billing=portal',
    });
  });

  it('creates a focused subscription-update flow with a completion redirect', async () => {
    const portalCreate = vi.fn().mockResolvedValue({ url: 'https://billing.stripe.test/session' });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ billingPortal: { sessions: { create: portalCreate } } }),
    });

    await client.createPortalSession({
      customerId: 'cus_123',
      returnUrl: 'https://app.matrix-os.com/runtime?new=1',
      flow: {
        type: 'subscription_update',
        subscriptionId: 'sub_123',
        priceId: 'price_extra_runtime_monthly',
        interval: 'monthly',
        configurationId: 'bpc_extra_monthly',
        afterCompletionReturnUrl: 'https://app.matrix-os.com/runtime?new=1',
      },
    });

    expect(portalCreate).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'https://app.matrix-os.com/runtime?new=1',
      configuration: 'bpc_extra_monthly',
      flow_data: {
        type: 'subscription_update',
        subscription_update: { subscription: 'sub_123' },
        after_completion: {
          type: 'redirect',
          redirect: { return_url: 'https://app.matrix-os.com/runtime?new=1' },
        },
      },
    });
  });

  it('uses the newest mature Stripe API version allowed by package policy', () => {
    expect(MATRIX_STRIPE_API_VERSION).toBe('2026-04-22.dahlia');
  });

  it('bounds Stripe API calls to the platform API timeout budget', () => {
    expect(MATRIX_STRIPE_API_TIMEOUT_MS).toBe(10_000);
  });
});

function fakeStripe(overrides: Record<string, unknown>) {
  return {
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
    ...overrides,
  } as never;
}
