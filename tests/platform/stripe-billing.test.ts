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
      customerId: 'cus_123',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });

    expect(sessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_123',
      line_items: [{ price: 'price_builder_monthly', quantity: 1 }],
      success_url: 'https://app.matrix-os.com/?checkout=success',
      cancel_url: 'https://app.matrix-os.com/?billing=canceled',
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: {
        address: 'auto',
        name: 'auto',
      },
    });
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('payment_method_types');
  });

  it('creates customers with Clerk user metadata', async () => {
    const customersCreate = vi.fn().mockResolvedValue({ id: 'cus_123' });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ customers: { create: customersCreate } }),
    });

    await expect(client.createCustomer({
      clerkUserId: 'user_123',
      idempotencyKey: 'billing-customer:user_123',
    })).resolves.toEqual({ id: 'cus_123' });
    expect(customersCreate).toHaveBeenCalledWith(
      { metadata: { clerk_user_id: 'user_123' } },
      { idempotencyKey: 'billing-customer:user_123' },
    );
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
    customers: { create: vi.fn() },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
    ...overrides,
  } as never;
}
