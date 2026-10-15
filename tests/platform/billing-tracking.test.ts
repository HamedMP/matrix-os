import { describe, expect, it } from 'vitest';
import { checkoutTrackingEvent, invoiceTrackingEvent, invoiceAcquisitionIdentity, withCheckoutSessionId } from '../../packages/platform/src/billing/tracking-events.js';

export const trackingMetadata = {
  matrix_plan_slug: 'matrix_builder', matrix_billing_interval: 'monthly', matrix_trial_days: '3',
  matrix_google_client_id: '123.456', matrix_google_analytics_consent: 'granted', matrix_google_expires_at: '4099680000000',
};
export function checkout(overrides: Record<string, unknown> = {}) {
  return { id: 'cs_live_123', livemode: true, status: 'complete', mode: 'subscription', payment_status: 'paid',
    amount_total: 12000, currency: 'usd', invoice: 'in_123', subscription: { id: 'sub_123', status: 'active' },
    total_details: { amount_tax: 2000, amount_shipping: 0 },
    line_items: { data: [{ price: { id: 'price_builder', recurring: { interval: 'month' } }, quantity: 1 }] },
    ...overrides };
}
export function invoice(overrides: Record<string, unknown> = {}) {
  return { id: 'in_123', livemode: true, status: 'paid', billing_reason: 'subscription_cycle', amount_paid: 12000, total: 12000, currency: 'usd',
    total_taxes: [{ amount: 2000 }], parent: { subscription_details: { subscription: 'sub_123', metadata: trackingMetadata } },
    ...overrides };
}

describe('verified billing tracking', () => {
  it.each([{ amount_paid: 0, total: 0 }, { livemode: false }, { livemode: undefined }])('does not consume acquisition eligibility for trials or test payments: %j', overrides => {
    expect(invoiceAcquisitionIdentity(invoice(overrides))).toBeNull();
  });
  it.each([false, undefined])('excludes test and unknown payment modes from all acquisition events: %j', livemode => {
    const plan = { planSlug: 'matrix_builder', interval: 'monthly' } as const;
    expect(checkoutTrackingEvent(checkout({ livemode }), plan)).toBeNull();
    expect(checkoutTrackingEvent(checkout({ livemode, amount_total: 0, payment_status: 'no_payment_required',
      subscription: { id: 'sub_123', status: 'trialing', trial_end: 2000000000 }, total_details: { amount_tax: 0 } }), plan)).toBeNull();
    expect(invoiceTrackingEvent(invoice({ livemode }))).toBeNull();
  });
  it('adds the literal Stripe placeholder without losing return parameters', () => {
    expect(withCheckoutSessionId('https://app.matrix-os.com/auth/device?user_code=ABCD&billing=success'))
      .toBe('https://app.matrix-os.com/auth/device?user_code=ABCD&billing=success&session_id={CHECKOUT_SESSION_ID}');
  });
  it('uses final discounted payment and separates tax from GA revenue', () => {
    expect(checkoutTrackingEvent(checkout(), { planSlug: 'matrix_builder', interval: 'monthly' }))
      .toMatchObject({ event: 'purchase', amount_paid: 120, plan: 'matrix_builder',
        ecommerce: { transaction_id: 'in_123', currency: 'USD', value: 100, tax: 20,
          items: [{ item_id: 'matrix_builder', item_variant: 'monthly', price: 100, quantity: 1 }] } });
  });
  it('captures an explicit free trial without a purchase', () => {
    expect(checkoutTrackingEvent(checkout({ amount_total: 0, payment_status: 'no_payment_required',
      subscription: { id: 'sub_123', status: 'trialing', trial_end: 2000000000 }, total_details: { amount_tax: 0 } }),
    { planSlug: 'matrix_builder', interval: 'monthly' })).toMatchObject({ event: 'trial_started', amount_paid: 0 });
  });
  it.each([{ status: 'open' }, { payment_status: 'unpaid' }, { amount_total: 0 }, { mode: 'payment' }])('ignores unpaid, unfinished and non-subscription checkouts: %j', overrides => {
    expect(checkoutTrackingEvent(checkout(overrides), { planSlug: 'matrix_builder', interval: 'monthly' })).toBeNull();
  });
  it('uses customer presentment currency and its currency exponent', () => {
    const result = checkoutTrackingEvent(checkout({ presentment_details: { presentment_amount: 18000, presentment_currency: 'jpy' } }),
      { planSlug: 'matrix_builder', interval: 'monthly' });
    expect(result).toMatchObject({ amount_paid: 18000, ecommerce: { currency: 'JPY', value: 15000, tax: 3000 } });
  });
  it('creates one acquisition purchase marked as trial converted from a paid invoice', () => {
    expect(invoiceTrackingEvent(invoice())).toMatchObject({ subscriptionId: 'sub_123', clientId: '123.456',
      event: { event: 'purchase', trial_converted: true, ecommerce: { transaction_id: 'in_123', value: 100 } } });
  });
  it.each([{ amount_paid: 0 }, { status: 'open' }, { billing_reason: 'subscription_update' },
    { parent: { subscription_details: { subscription: 'sub_123', metadata: { ...trackingMetadata, matrix_google_analytics_consent: 'denied' } } } }])('ignores ineligible invoices: %j', overrides => {
    expect(invoiceTrackingEvent(invoice(overrides))).toBeNull();
  });
});
