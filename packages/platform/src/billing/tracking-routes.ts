import { Hono, type Context } from 'hono';
import { z } from 'zod/v4';
import { loadStripePriceCatalog } from '../billing.js';
import type { StripeBillingClient } from './stripe-client.js';
import { checkoutTrackingEvent } from './tracking-events.js';
import { billingTrackingScript } from './tracking-browser.js';

export function createBillingTrackingRoutes(options: {
  stripe: Pick<StripeBillingClient, 'apiTimeoutMs' | 'retrieveTrackingCheckout'>;
  resolveClerkUserId: (c: Context) => Promise<string | null>; env?: NodeJS.ProcessEnv;
}): Hono {
  const app = new Hono();
  const env = options.env ?? process.env;
  app.get('/tracking.js', c => {
    c.header('cache-control', 'no-store');
    c.header('content-type', 'application/javascript; charset=utf-8');
    return c.body(billingTrackingScript(env.GOOGLE_TAG_MANAGER_ID ?? 'GTM-5D8ZT4HF'));
  });
  app.get('/checkout-result', async c => {
    c.header('cache-control', 'private, no-store');
    const owner = await options.resolveClerkUserId(c);
    if (!owner) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = z.string().regex(/^cs_(?:test_|live_)?[A-Za-z0-9_]{1,240}$/).safeParse(c.req.query('session_id'));
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    if (!options.stripe.retrieveTrackingCheckout || options.stripe.apiTimeoutMs > 10000) return c.json({ error: 'Billing unavailable' }, 503);
    try {
      const raw = await options.stripe.retrieveTrackingCheckout(parsed.data);
      const session = z.object({ id: z.literal(parsed.data), client_reference_id: z.literal(owner),
        line_items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }) })) }),
      }).safeParse(raw);
      if (!session.success) return c.json({ error: 'Not found' }, 404);
      const price = session.data.line_items.data;
      const plan = price.length === 1 ? loadStripePriceCatalog(env).priceToPlan.get(price[0].price.id) : undefined;
      const event = plan ? checkoutTrackingEvent(raw, plan) : null;
      return c.json({ event });
    } catch (error: unknown) {
      console.warn('[billing] Checkout tracking unavailable:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Billing unavailable' }, 503);
    }
  });
  return app;
}
