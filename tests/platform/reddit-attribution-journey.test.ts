// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { getCheckoutAttribution } from '../../shell/src/lib/marketing-attribution.js';
import { MarketingAttributionSchema } from '../../packages/platform/src/billing/checkout-schemas.js';
import { createStripeBillingClient } from '../../packages/platform/src/stripe-billing.js';
import { deliverRedditAttribution } from '../../packages/platform/src/reddit-purchase-attribution.js';
import { createRedditConversionsClient } from '../../packages/platform/src/reddit-conversions.js';

afterEach(() => {
  window.localStorage.clear();
  document.cookie = 'matrix_marketing_consent_v1=; Max-Age=0; path=/';
  window.history.replaceState({}, '', '/');
});

it('keeps the same consented click from app handoff through Checkout, trial and first paid invoice', async () => {
  const now = Date.now();
  const expiresAt = now + 86400000;
  document.cookie = 'matrix_marketing_consent_v1=' + encodeURIComponent(JSON.stringify({ version: 1, choice: 'accepted', expiresAt })) + '; path=/';
  window.history.replaceState({}, '', '/?rdt_cid=exact-click-123&utm_source=reddit&utm_campaign=pilot&email=exclude');
  const attribution = MarketingAttributionSchema.parse(getCheckoutAttribution());
  window.history.replaceState({}, '', '/onboarding');
  expect(getCheckoutAttribution()).toEqual(attribution);

  const create = vi.fn().mockResolvedValue({ id: 'cs_journey', url: 'https://checkout.stripe.test/session' });
  const stripe = createStripeBillingClient({ secretKey: 'sk_test_fixture', stripe: {
    checkout: { sessions: { create } },
  } as unknown as NonNullable<Parameters<typeof createStripeBillingClient>[0]['stripe']> });
  await stripe.createCheckoutSession({
    clerkUserId: 'user_fixture', idempotencyKey: 'attempt_fixture', priceId: 'price_starter', mode: 'subscription',
    automaticTax: true, allowPromotionCodes: true, regionSlug: 'region_fsn1', runtimeSlot: 'primary',
    redditAttributionExpiresAt: new Date(expiresAt).toISOString(), attribution,
    successUrl: 'https://app.matrix-os.com/', cancelUrl: 'https://app.matrix-os.com/',
  });
  const metadata = create.mock.calls[0][0].metadata;
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const capi = createRedditConversionsClient({ env: { REDDIT_PIXEL_ID: 'a2_fixture', REDDIT_CONVERSIONS_ACCESS_TOKEN: 'fixture-only' }, fetcher });
  await deliverRedditAttribution({ type: 'checkout.session.completed', created: Math.floor(now / 1000), data: { object: {
    id: 'cs_journey', mode: 'subscription', client_reference_id: 'user_fixture', amount_total: 0, currency: 'usd', metadata,
  } } }, capi);
  const clearSubscriptionAttribution = vi.fn().mockResolvedValue(undefined);
  const invoice = { type: 'invoice.paid', created: Math.floor(now / 1000), data: { object: {
    id: 'in_journey', billing_reason: 'subscription_cycle', amount_paid: 2000, currency: 'usd',
    parent: { subscription_details: { subscription: 'sub_journey', metadata } },
  } } };
  await deliverRedditAttribution(invoice, capi, { clearSubscriptionAttribution });
  await deliverRedditAttribution(invoice, capi, { clearSubscriptionAttribution });
  const events = fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).data.events[0]);
  expect(events.map(event => event.type.tracking_type)).toEqual(['SIGN_UP', 'PURCHASE', 'PURCHASE']);
  for (const event of events) {
    expect(event.click_id).toBe('exact-click-123');
    expect(new URL(event.event_source_url).searchParams.get('rdt_cid')).toBe('exact-click-123');
    expect(event.user).toEqual({ external_id: createHash('sha256').update('user_fixture').digest('hex') });
    expect(JSON.stringify(event)).not.toContain('email');
  }
  expect(events[0].metadata).not.toHaveProperty('value');
  expect(events[1].metadata).toMatchObject({ value: 20, currency: 'USD' });
  expect(events[2].metadata.conversion_id).toBe(events[1].metadata.conversion_id);
  expect(clearSubscriptionAttribution).toHaveBeenCalledWith('sub_journey');
});
