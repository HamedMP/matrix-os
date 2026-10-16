import { describe, expect, it, vi } from 'vitest';
import { createGooglePurchaseSender } from '../../packages/platform/src/billing/google-purchases.js';
import type { InvoiceTrackingPurchase } from '../../packages/platform/src/billing/tracking-events.js';
const purchase: InvoiceTrackingPurchase = { subscriptionId: 'sub_123', clientId: '123.456', adUserData: 'denied', adPersonalization: 'denied',
  eventAt: 1792065600000, event: { event: 'purchase', event_id: 'purchase_in_123', plan: 'matrix_builder', billing_interval: 'monthly', amount_paid: 120, trial_converted: true,
    ecommerce: { transaction_id: 'in_123', value: 100, tax: 20, currency: 'USD', items: [] } } };
describe('Google trial-to-paid delivery', () => {
  it('sends a purchase marked trial_converted to the same GA4 web stream with the original client identity', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const sender = createGooglePurchaseSender({ GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-TEST123', GOOGLE_ANALYTICS_API_SECRET: 'test_secret' }, fetcher);
    expect(await sender.send(purchase)).toBe('sent');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toContain('region1.google-analytics.com/mp/collect');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({ client_id: '123.456', timestamp_micros: 1792065600000000,
      consent: { ad_user_data: 'DENIED' }, events: [{ name: 'purchase', params: { transaction_id: 'in_123', value: 100, currency: 'USD', trial_converted: true } }] });
  });
  it('does not send without a private server configuration', async () => {
    const fetcher = vi.fn(); expect(await createGooglePurchaseSender({}, fetcher).send(purchase)).toBe('disabled');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not leak the secret or provider errors on failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('test_secret provider failure'));
    await expect(createGooglePurchaseSender({ GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-TEST123', GOOGLE_ANALYTICS_API_SECRET: 'test_secret' }, fetcher).send(purchase))
      .rejects.toThrow('GooglePurchaseDeliveryError');
  });
});
