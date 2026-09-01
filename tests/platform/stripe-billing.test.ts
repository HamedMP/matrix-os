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
    const subscriptionInput = {
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
    } as const;
    await expect(client.createCheckoutSession(subscriptionInput))
      .resolves.toEqual({ url: 'https://checkout.stripe.test/session', id: 'cs_123' });
    await client.createCheckoutSession(subscriptionInput);

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
    expect(sessionsCreate.mock.calls[1]).toEqual(sessionsCreate.mock.calls[0]);
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

  it('collects a trial payment method without restricting Stripe dynamic payment methods', async () => {
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

  it('retrieves the authoritative recurring amount for legacy subscriptions', async () => {
    const pricesRetrieve = vi.fn().mockResolvedValue({
      id: 'price_legacy_builder_monthly',
      unit_amount: 2000,
      currency: 'usd',
      recurring: { interval: 'month', interval_count: 1 },
    });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ prices: { retrieve: pricesRetrieve } }),
    });

    await expect(client.retrieveRecurringPrice('price_legacy_builder_monthly')).resolves.toEqual({
      priceId: 'price_legacy_builder_monthly',
      unitAmountMinor: 2000,
      currency: 'usd',
      interval: 'monthly',
      intervalCount: 1,
    });
    expect(pricesRetrieve).toHaveBeenCalledWith('price_legacy_builder_monthly');
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

  it('creates one-time AI credit checkout with only server-written identity and package metadata', async () => {
    const sessionsCreate = vi.fn().mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/cs_ai_5',
      id: 'cs_ai_5',
    });
    const client = createStripeBillingClient({
      secretKey: 'sk_test_123',
      stripe: fakeStripe({ checkout: { sessions: { create: sessionsCreate } } }),
    });

    const checkoutInput = {
      clerkUserId: 'user_123',
      requestId: '77f105df-6e24-4e13-a881-af9ce20d6a63',
      machineId: 'machine_123',
      runtimeSlot: 'primary',
      packageId: 'usd_5',
      priceId: 'price_ai_5',
      amountMicrousd: 5_000_000,
      automaticTax: false,
      idempotencyKey: '77f105df-6e24-4e13-a881-af9ce20d6a63',
      successUrl: 'https://app.matrix-os.com/?billing=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    } as const;
    await expect(client.createAiCreditCheckoutSession(checkoutInput))
      .resolves.toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_ai_5', id: 'cs_ai_5' });
    await client.createAiCreditCheckoutSession(checkoutInput);
    expect(sessionsCreate).toHaveBeenCalledWith({
      mode: 'payment',
      integration_identifier: expect.stringMatching(/^matrix-ai-credit-[a-z]{8}$/),
      client_reference_id: 'user_123',
      line_items: [{ price: 'price_ai_5', quantity: 1 }],
      success_url: 'https://app.matrix-os.com/?billing=success',
      cancel_url: 'https://app.matrix-os.com/?billing=canceled',
      automatic_tax: { enabled: false },
      metadata: {
        matrix_checkout_kind: 'ai_credit_addon',
        matrix_owner_id: 'user_123',
        matrix_machine_id: 'machine_123',
        matrix_runtime_slot: 'primary',
        matrix_ai_credit_package_id: 'usd_5',
        matrix_ai_credit_request_id: '77f105df-6e24-4e13-a881-af9ce20d6a63',
        matrix_ai_credit_price_id: 'price_ai_5',
        matrix_ai_credit_microusd: '5000000',
      },
      payment_intent_data: {
        metadata: {
          matrix_checkout_kind: 'ai_credit_addon',
          matrix_owner_id: 'user_123',
          matrix_machine_id: 'machine_123',
          matrix_runtime_slot: 'primary',
          matrix_ai_credit_package_id: 'usd_5',
          matrix_ai_credit_request_id: '77f105df-6e24-4e13-a881-af9ce20d6a63',
          matrix_ai_credit_price_id: 'price_ai_5',
          matrix_ai_credit_microusd: '5000000',
        },
      },
    }, { idempotencyKey: '77f105df-6e24-4e13-a881-af9ce20d6a63' });
    expect(sessionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('payment_method_types');
    expect(sessionsCreate.mock.calls[1]).toEqual(sessionsCreate.mock.calls[0]);
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
    prices: { retrieve: vi.fn() },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
    ...overrides,
  } as never;
}
