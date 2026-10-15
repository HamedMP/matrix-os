import type { PlatformDB } from '../db.js';
import { deliverGooglePurchases, type GooglePurchaseSender } from './google-purchase-store.js';
import type { InvoiceTrackingPurchase } from './tracking-events.js';

export function createGooglePurchaseSender(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): GooglePurchaseSender {
  const measurementId = env.GOOGLE_ANALYTICS_MEASUREMENT_ID;
  const apiSecret = env.GOOGLE_ANALYTICS_API_SECRET;
  return { async send(purchase: InvoiceTrackingPurchase) {
    if (purchase.consentExpiresAt && purchase.consentExpiresAt <= Date.now()) return 'disabled';
    if (!measurementId || !/^G-[A-Z0-9]+$/.test(measurementId) || !apiSecret) return 'disabled';
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

export function startGooglePurchaseDelivery(db: PlatformDB, env: NodeJS.ProcessEnv): () => Promise<void> {
  if (!env.GOOGLE_ANALYTICS_MEASUREMENT_ID || !env.GOOGLE_ANALYTICS_API_SECRET) return async () => undefined;
  const sender = createGooglePurchaseSender(env);
  let pending: Promise<void> | undefined;
  let closed = false;
  function tick() {
    if (closed || pending) return;
    pending = deliverGooglePurchases(db, sender).then(() => undefined).catch((error: unknown) => {
      console.warn('[billing] Google delivery queue unavailable:', error instanceof Error ? error.name : typeof error);
    }).finally(() => { pending = undefined; });
  }
  const timer = setInterval(tick, 30000);
  timer.unref();
  tick();
  return async () => { closed = true; clearInterval(timer); await pending; };
}
