// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { billingTrackingScript } from '../../packages/platform/src/billing/tracking-browser.js';
const purchase = { event: 'purchase', event_id: 'purchase_in_123', plan: 'matrix_builder', billing_interval: 'monthly', amount_paid: 120,
  ecommerce: { transaction_id: 'in_123', currency: 'USD', value: 100, tax: 20, items: [] } };
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('browser GTM checkout tracking', () => {
  beforeEach(() => {
    localStorage.clear(); document.cookie = 'matrix_marketing_consent_v1=; Max-Age=0; path=/';
    history.replaceState({}, '', '/?billing=success&checkout=success&session_id=cs_test_123');
    for (const key of ['__matrixBillingTracking', 'dataLayer', 'matrixGetGoogleAttribution']) delete (window as unknown as Record<string, unknown>)[key];
    document.getElementById('matrix-google-tag-manager')?.remove();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ event: purchase }) }));
  });
  it('queues consent defaults before GTM and populates URL from verified payment', async () => {
    window.eval(billingTrackingScript('GTM-5D8ZT4HF')); await settle();
    const layer = (window as unknown as { dataLayer: Array<Record<string, unknown> | IArguments> }).dataLayer;
    expect(Array.from(layer[0] as IArguments)).toMatchObject(['consent', 'default', { analytics_storage: 'denied' }]);
    expect(layer.filter(e => 'event' in e && e.event === 'purchase')).toHaveLength(1);
    expect(location.search).toContain('currency=USD'); expect(location.search).toContain('amount=120');
    expect(location.search).not.toContain('session_id');
  });
  it('does not emit again on refresh or when the original return URL is revisited', async () => {
    window.eval(billingTrackingScript('GTM-5D8ZT4HF')); await settle();
    delete (window as unknown as Record<string, unknown>).__matrixBillingTracking;
    history.replaceState({}, '', '/?checkout=success&session_id=cs_test_123');
    window.eval(billingTrackingScript('GTM-5D8ZT4HF')); await settle();
    expect((window as unknown as { dataLayer: Array<Record<string, unknown>> }).dataLayer.filter(e => e.event === 'purchase')).toHaveLength(1);
  });
  it('emits a trial event without a purchase and preserves device parameters', async () => {
    history.replaceState({}, '', '/auth/device?user_code=ABCD&session_id=cs_test_123');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ event: { ...purchase, event: 'trial_started', event_id: 'trial_sub_123', amount_paid: 0 } }) } as Response);
    window.eval(billingTrackingScript('GTM-5D8ZT4HF')); await settle();
    const layer = (window as unknown as { dataLayer: Array<Record<string, unknown>> }).dataLayer;
    expect(layer.filter(e => e.event === 'purchase')).toHaveLength(0);
    expect(layer.filter(e => e.event === 'trial_started')).toHaveLength(1);
    expect(location.search).toContain('user_code=ABCD'); expect(location.search).toContain('trial=true');
  });
  it('does not trust query fields without a verified session', async () => {
    history.replaceState({}, '', '/?checkout=success&amount=999&currency=USD');
    window.eval(billingTrackingScript('GTM-5D8ZT4HF')); await settle();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('storage-restricted checkout returns', () => {
  it('clears the session token before refresh even when conversion receipt storage is blocked', async () => {
    const storage = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    history.replaceState({}, '', '/?checkout=success&session_id=cs_test_blocked');
    delete (window as unknown as Record<string, unknown>).__matrixBillingTracking;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ event: purchase }) }));
    window.eval(billingTrackingScript('GTM-5D8ZT4HF')); await settle();
    expect(location.search).not.toContain('session_id');
    delete (window as unknown as Record<string, unknown>).__matrixBillingTracking;
    vi.mocked(fetch).mockClear();
    window.eval(billingTrackingScript('GTM-5D8ZT4HF')); await settle();
    expect(fetch).not.toHaveBeenCalled();
    storage.mockRestore(); write.mockRestore();
  });
});
