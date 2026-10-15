import type { PlatformDB } from '../db.js';
import { deliverGooglePurchases, expireGoogleTracking, type GooglePurchaseSender } from './google-purchase-store.js';
import { invoiceTrackingEvent, type InvoiceTrackingPurchase } from './tracking-events.js';
import type { StripeBillingClient } from './stripe-client.js';
import { createStripeBillingClient } from '../stripe-billing.js';

/** The process lifecycle owns background work; HTTP app construction has no timers. */
export function startGooglePurchaseWorker(db: PlatformDB, env: NodeJS.ProcessEnv,
  backgroundWorkersEnabled: boolean): () => Promise<void> {
  if (!backgroundWorkersEnabled) return async () => undefined;
  const stripe = env.STRIPE_SECRET_KEY ? createStripeBillingClient({ secretKey: env.STRIPE_SECRET_KEY }) : undefined;
  return startGooglePurchaseDelivery(db, env, stripe);
}

export function createGooglePurchaseSender(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch,
  retrieveInvoice?: (id: string) => Promise<unknown>): GooglePurchaseSender {
  const measurementId = env.GOOGLE_ANALYTICS_MEASUREMENT_ID;
  const apiSecret = env.GOOGLE_ANALYTICS_API_SECRET;
  return { async send(purchase: InvoiceTrackingPurchase) {
    if (purchase.consentExpiresAt && purchase.consentExpiresAt <= Date.now()) return 'disabled';
    if (!measurementId || !/^G-[A-Z0-9]+$/.test(measurementId) || !apiSecret) return 'disabled';
    if (purchase.needsInvoiceLookup) {
      if (!retrieveInvoice) throw new Error('GooglePurchaseDeliveryError');
      const detailed = invoiceTrackingEvent(await retrieveInvoice(purchase.event.ecommerce.transaction_id));
      // A successful lookup may confirm a test, mixed or partial payment.
      // Clear its payload without recording a send; only lookup failures retry.
      if (!detailed) return 'skipped';
      if (detailed.subscriptionId !== purchase.subscriptionId
        || detailed.event.ecommerce.transaction_id !== purchase.event.ecommerce.transaction_id) throw new Error('GooglePurchaseDeliveryError');
      // Keep the original consent, identity and event timestamp across retries.
      purchase = { ...purchase, event: detailed.event };
    }
    const endpoint = new URL('https://region1.google-analytics.com/mp/collect');
    endpoint.searchParams.set('measurement_id', measurementId);
    endpoint.searchParams.set('api_secret', apiSecret);
    const { event: name, ecommerce, ...properties } = purchase.event;
    const params = { ...properties, ...ecommerce, engagement_time_msec: 1 };
    const events = [{ name, params }];
    // Never log the URL, body or provider error: the URL contains the MP secret.
    try {
      const response = await fetcher(endpoint.toString(), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: purchase.clientId, ...(purchase.eventAt ? { timestamp_micros: purchase.eventAt * 1000 } : {}), consent: {
          ad_user_data: purchase.adUserData.toUpperCase(), ad_personalization: purchase.adPersonalization.toUpperCase(),
        }, events }), signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new Error('GooglePurchaseDeliveryError');
      return 'sent';
    } catch (error: unknown) {
      throw new Error('GooglePurchaseDeliveryError', { cause: error instanceof TypeError ? 'network' : 'delivery' });
    }
  } };
}

export function startGooglePurchaseDelivery(db: PlatformDB, env: NodeJS.ProcessEnv,
  stripe?: Pick<StripeBillingClient, 'retrieveTrackingInvoice'>): () => Promise<void> {
  const enabled = Boolean(env.GOOGLE_ANALYTICS_MEASUREMENT_ID && env.GOOGLE_ANALYTICS_API_SECRET);
  const sender = createGooglePurchaseSender(env, fetch, stripe?.retrieveTrackingInvoice?.bind(stripe));
  let pending: Promise<void> | undefined;
  let closed = false;
  function tick() {
    if (closed || pending) return;
    pending = (enabled ? deliverGooglePurchases(db, sender) : expireGoogleTracking(db)).then(() => undefined).catch((error: unknown) => {
      console.warn('[billing] Google delivery queue unavailable:', error instanceof Error ? error.name : typeof error);
    }).finally(() => { pending = undefined; });
  }
  const timer = setInterval(tick, 30000);
  timer.unref();
  tick();
  return async () => { closed = true; clearInterval(timer); await pending; };
}
