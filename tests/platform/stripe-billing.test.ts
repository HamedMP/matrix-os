import { describe, expect, it, vi } from 'vitest';
import {
  createStripeBillingClient,
  MATRIX_STRIPE_API_TIMEOUT_MS,
  MATRIX_STRIPE_API_VERSION,
} from '../../packages/platform/src/stripe-billing.js';

describe('platform/stripe-billing', () => {
  it('creates subscription checkout sessions with tax and promotion-code support', async () => {
    const sessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session', id: 'cs_123' });
    const stripe = fakeStripe({
      checkout: { sessions: { create: sessionsCreate } },
    });
    const client = createStripeBillingClient({ secretKey: 'sk_test_123', stripe });

    expect(client.apiTimeoutMs).toBe(MATRIX_STRIPE_API_TIMEOUT_MS);
    await expect(client.createCheckoutSession({
      clerkUserId: 'user_123',
      idempotencyKey: 'attempt_123',
      customerId: 'cus_123',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_nbg1',
      runtimeSlot: 'studio',
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session', id: 'cs_123' });

    expect(sessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_123',
      client_reference_id: 'user_123',
      line_items: [{ price: 'price_builder_monthly', quantity: 1 }],
      success_url: 'https://app.matrix-os.com/?checkout=success',
      cancel_url: 'https://app.matrix-os.com/?billing=canceled',
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      integration_identifier: expect.stringMatching(/^matrix_checkout_[a-z]{8}$/),
      metadata: {
        clerk_user_id: 'user_123',
        matrix_region_slug: 'region_nbg1',
        matrix_runtime_slot: 'studio',
      },
      subscription_data: {
        metadata: {
          clerk_user_id: 'user_123',
          matrix_region_slug: 'region_nbg1',
          matrix_runtime_slot: 'studio',
        },
      },
      tax_id_collection: { enabled: true },
      customer_update: {
        address: 'auto',
        name: 'auto',
      },
    }, { idempotencyKey: 'attempt_123' });
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('payment_method_types');

    await client.createCheckoutSession({
      clerkUserId: 'user_123',
      idempotencyKey: 'attempt_123',
      customerId: 'cus_123',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_nbg1',
      runtimeSlot: 'studio',
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    });
    expect(sessionsCreate.mock.calls[1]?.[0].integration_identifier).toBe(
      sessionsCreate.mock.calls[0]?.[0].integration_identifier,
    );
  });

  it('creates checkout sessions without customer-write permission when no customer exists yet', async () => {
    const sessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session', id: 'cs_456' });
    const stripe = fakeStripe({
      checkout: { sessions: { create: sessionsCreate } },
    });
    const client = createStripeBillingClient({ secretKey: 'sk_test_123', stripe });

    await expect(client.createCheckoutSession({
      clerkUserId: 'user_123',
      idempotencyKey: 'attempt_456',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_nbg1',
      runtimeSlot: 'primary',
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session', id: 'cs_456' });
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('customer');
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('customer_update');
    expect(sessionsCreate.mock.calls[0]?.[0]).toMatchObject({
      client_reference_id: 'user_123',
      metadata: { clerk_user_id: 'user_123', matrix_runtime_slot: 'primary' },
      subscription_data: { metadata: { clerk_user_id: 'user_123', matrix_runtime_slot: 'primary' } },
    });
  });

  it('creates a card-required native Stripe trial when trial days are present', async () => {
    const sessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/trial', id: 'cs_trial' });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ checkout: { sessions: { create: sessionsCreate } } }),
    });

    await client.createCheckoutSession({
      clerkUserId: 'user_123',
      idempotencyKey: 'attempt_trial',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_fsn1',
      runtimeSlot: 'primary',
      trialPeriodDays: 7,
      paymentMethodMode: 'card_required',
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    });

    expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      payment_method_collection: 'always',
      subscription_data: expect.objectContaining({
        trial_period_days: 7,
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' },
        },
      }),
    }), { idempotencyKey: 'attempt_trial' });
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('payment_method_types');
  });

  it('binds an eligible preparation intent to an explicitly expiring checkout and subscription', async () => {
    const sessionsCreate = vi.fn().mockResolvedValue({
      url: 'https://checkout.stripe.test/prebilling',
      id: 'cs_prebilling',
      expires_at: 1_787_567_400,
    });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ checkout: { sessions: { create: sessionsCreate } } }),
    });

    await expect(client.createCheckoutSession({
      clerkUserId: 'user_123',
      idempotencyKey: 'attempt_prebilling',
      priceId: 'price_builder_monthly',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_fsn1',
      runtimeSlot: 'primary',
      prebillingIntentId: 'intent_123',
      expiresAt: '2026-08-24T10:30:00.000Z',
      successUrl: 'https://app.matrix-os.com/?checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    })).resolves.toMatchObject({
      id: 'cs_prebilling',
      expiresAt: '2026-08-24T10:30:00.000Z',
    });
    expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      expires_at: 1_787_567_400,
      metadata: expect.objectContaining({ matrix_prebilling_intent_id: 'intent_123' }),
      subscription_data: expect.objectContaining({
        metadata: expect.objectContaining({ matrix_prebilling_intent_id: 'intent_123' }),
      }),
    }), { idempotencyKey: 'attempt_prebilling' });
  });

  it('retrieves the authoritative selection for a persisted checkout session', async () => {
    const sessionsRetrieve = vi.fn().mockResolvedValue({
      status: 'open',
      url: 'https://checkout.stripe.test/legacy',
      client_reference_id: 'user_123',
      metadata: { matrix_region_slug: 'region_fsn1' },
      line_items: {
        data: [{ price: { id: 'price_builder_monthly' } }],
      },
    });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ checkout: { sessions: { retrieve: sessionsRetrieve } } }),
    });

    await expect((
      client as unknown as {
        retrieveCheckoutSession(id: string): Promise<unknown>;
      }
    ).retrieveCheckoutSession('cs_legacy')).resolves.toEqual({
      status: 'open',
      url: 'https://checkout.stripe.test/legacy',
      clerkUserId: 'user_123',
      priceId: 'price_builder_monthly',
      regionSlug: 'region_fsn1',
    });
    expect(sessionsRetrieve).toHaveBeenCalledWith('cs_legacy', {
      expand: ['line_items.data.price'],
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

  it('uses the newest mature Stripe API version allowed by package policy', () => {
    expect(MATRIX_STRIPE_API_VERSION).toBe('2026-07-29.dahlia');
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
