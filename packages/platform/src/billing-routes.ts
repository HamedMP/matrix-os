import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import {
  getBillingCustomerByClerkUserId,
  getBillingCustomerByStripeCustomerId,
  getBillingEntitlement,
  insertBillingCustomerIfAbsent,
  insertBillingWebhookEvent,
  runBillingWebhookTransaction,
  upsertBillingEntitlement,
  type BillingCustomerRecord,
  type PlatformDB,
} from './db.js';
import {
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  parseBillingEntitlementRecord,
  type BillingEntitlementStatus,
  type MatrixBillingPlanSlug,
  type MatrixBillingInterval,
  type StripeSubscriptionProjection,
} from './billing.js';

const BILLING_BODY_LIMIT = 16 * 1024;
const STRIPE_WEBHOOK_BODY_LIMIT = 1024 * 1024;
const MAX_STRIPE_API_TIMEOUT_MS = 10_000;
const CUSTOMER_CREATION_INFLIGHT_LIMIT = 1024;
const customerCreationInflight = new Map<string, Promise<BillingCustomerRecord>>();

const CheckoutRequestSchema = z.object({
  planSlug: z.enum(['matrix_starter', 'matrix_builder', 'matrix_max']),
  interval: z.enum(['monthly', 'annual']).default('monthly'),
});

export interface StripeCheckoutSessionInput {
  customerId: string;
  priceId: string;
  mode: 'subscription';
  automaticTax: boolean;
}

export interface StripeBillingClient {
  apiTimeoutMs: number;
  /**
   * Implementations must pass idempotencyKey through to Stripe and use a bounded
   * network timeout. Callers rely on that to avoid duplicate customer creation
   * without holding database locks across external API calls.
   */
  createCustomer(input: { clerkUserId: string; idempotencyKey: string }): Promise<{ id: string }>;
  createCheckoutSession(input: StripeCheckoutSessionInput): Promise<{ url: string }>;
  createPortalSession(input: { customerId: string }): Promise<{ url: string }>;
  constructWebhookEvent(rawBody: string, signature: string, webhookSecret: string): StripeWebhookEvent;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  data: { object: unknown };
}

export function createBillingRoutes(options: {
  db: PlatformDB;
  stripe: StripeBillingClient;
  env?: NodeJS.ProcessEnv;
  resolveClerkUserId: (c: Context) => Promise<string | null>;
  now?: () => Date;
  upsertEntitlement?: typeof upsertBillingEntitlement;
}): Hono {
  const app = new Hono();
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const persistEntitlement = options.upsertEntitlement ?? upsertBillingEntitlement;

  async function resolveRouteClerkUserId(c: Context, route: string): Promise<string | null> {
    try {
      return await options.resolveClerkUserId(c);
    } catch (err: unknown) {
      console.warn(`[billing] ${route} auth resolution failed:`, err instanceof Error ? err.name : typeof err);
      return null;
    }
  }

  app.post('/checkout', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), async (c) => {
    const clerkUserId = await resolveRouteClerkUserId(c, 'checkout');
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
      throw err;
    }
    const parsed = CheckoutRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);

    const priceId = resolvePriceId(env, parsed.data.planSlug, parsed.data.interval);
    if (!priceId) return c.json({ error: 'Billing unavailable' }, 503);

    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error('stripe_timeout_exceeds_budget');
      }
      const customer = await getOrCreateCustomer(options.db, options.stripe, clerkUserId, now());
      const session = await options.stripe.createCheckoutSession({
        customerId: customer.stripeCustomerId,
        priceId,
        mode: 'subscription',
        automaticTax: true,
      });
      return c.json({ url: session.url }, 200);
    } catch (err: unknown) {
      console.error('[billing] checkout creation failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Billing unavailable' }, 503);
    }
  });

  app.post('/portal', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), async (c) => {
    const clerkUserId = await resolveRouteClerkUserId(c, 'portal');
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);

    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error('stripe_timeout_exceeds_budget');
      }
      const customer = await getBillingCustomerByClerkUserId(options.db, clerkUserId);
      if (!customer) return c.json({ error: 'Billing unavailable' }, 404);
      const session = await options.stripe.createPortalSession({ customerId: customer.stripeCustomerId });
      return c.json({ url: session.url }, 200);
    } catch (err: unknown) {
      console.error('[billing] portal creation failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Billing unavailable' }, 503);
    }
  });

  app.get('/status', async (c) => {
    const clerkUserId = await resolveRouteClerkUserId(c, 'status');
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const entitlement = await getBillingEntitlement(options.db, clerkUserId);
      const access = getRuntimeAccessDecision(parseBillingEntitlementRecord(entitlement), now());
      return c.json({ entitlement: entitlement ?? null, access }, 200);
    } catch (err: unknown) {
      console.error('[billing] status lookup failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Billing unavailable' }, 503);
    }
  });

  app.post('/webhooks/stripe', bodyLimit({ maxSize: STRIPE_WEBHOOK_BODY_LIMIT }), async (c) => {
    const signature = c.req.header('stripe-signature');
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !webhookSecret) return c.json({ error: 'Invalid webhook' }, 400);

    const rawBody = await c.req.text();
    let event: StripeWebhookEvent;
    try {
      event = options.stripe.constructWebhookEvent(rawBody, signature, webhookSecret);
    } catch (err: unknown) {
      console.warn('[billing] invalid Stripe webhook signature:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Invalid webhook' }, 400);
    }

    try {
      const result = await runBillingWebhookTransaction(options.db, async (trx) => {
        const inserted = await insertBillingWebhookEvent(trx, {
          stripeEventId: event.id,
          eventType: event.type,
          createdAtFromStripe: epochSecondsToIso(event.created),
          processedAt: now().toISOString(),
          status: 'processed',
          errorCode: null,
        });
        if (!inserted.inserted) {
          return { received: true, duplicate: true };
        }

        if (!isSubscriptionEvent(event.type)) {
          return { received: true, ignored: true };
        }

        const projection = await projectSubscription(trx, event.data.object);
        if (!projection) return { received: true, ignored: true };

        const entitlement = deriveStripeEntitlement(projection, {
          priceCatalog: loadStripePriceCatalog(env),
          runtimeCatalog: loadRuntimeCatalog(env),
          now: now(),
        });
        await persistEntitlement(trx, entitlement);
        return { received: true, processed: true };
      });
      return c.json(result, 200);
    } catch (err: unknown) {
      console.error('[billing] Stripe webhook processing failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Webhook processing failed' }, 500);
    }
  });

  app.all('*', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), (c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  return app;
}

async function getOrCreateCustomer(
  db: PlatformDB,
  stripe: StripeBillingClient,
  clerkUserId: string,
  currentTime: Date,
) {
  const existing = await getBillingCustomerByClerkUserId(db, clerkUserId);
  if (existing) return existing;

  const pending = customerCreationInflight.get(clerkUserId);
  if (pending) return pending;
  if (customerCreationInflight.size >= CUSTOMER_CREATION_INFLIGHT_LIMIT) {
    throw new Error('customer_creation_inflight_limit');
  }
  const created = createAndPersistCustomer(db, stripe, clerkUserId, currentTime);
  customerCreationInflight.set(clerkUserId, created);
  try {
    return await created;
  } finally {
    customerCreationInflight.delete(clerkUserId);
  }
}

async function createAndPersistCustomer(
  db: PlatformDB,
  stripe: StripeBillingClient,
  clerkUserId: string,
  currentTime: Date,
): Promise<BillingCustomerRecord> {
  const customer = await stripe.createCustomer({
    clerkUserId,
    idempotencyKey: billingCustomerIdempotencyKey(clerkUserId),
  });

  const nowIso = currentTime.toISOString();
  await insertBillingCustomerIfAbsent(db, {
    clerkUserId,
    stripeCustomerId: customer.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const persisted = await getBillingCustomerByClerkUserId(db, clerkUserId);
  if (!persisted) throw new Error('billing customer was not persisted');
  return persisted;
}

function billingCustomerIdempotencyKey(clerkUserId: string): string {
  return `billing-customer:${clerkUserId}`;
}

function resolvePriceId(
  env: NodeJS.ProcessEnv,
  planSlug: MatrixBillingPlanSlug,
  interval: MatrixBillingInterval,
): string | undefined {
  const key = `STRIPE_PRICE_${planSlug.toUpperCase()}_${interval.toUpperCase()}`;
  return env[key];
}

function isSubscriptionEvent(type: string): boolean {
  return (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  );
}

async function projectSubscription(db: PlatformDB, value: unknown): Promise<StripeSubscriptionProjection | null> {
  if (!value || typeof value !== 'object') return null;
  const sub = value as {
    id?: unknown;
    customer?: unknown;
    status?: unknown;
    current_period_end?: unknown;
    items?: { data?: unknown };
  };
  if (typeof sub.id !== 'string' || typeof sub.customer !== 'string') return null;
  const customer = await getBillingCustomerByStripeCustomerId(db, sub.customer);
  if (!customer) return null;
  const status = normalizeSubscriptionStatus(sub.status);
  const data = Array.isArray(sub.items?.data) ? sub.items.data : [];
  return {
    clerkUserId: customer.clerkUserId,
    stripeCustomerId: customer.stripeCustomerId,
    stripeSubscriptionId: sub.id,
    status,
    currentPeriodEnd: typeof sub.current_period_end === 'number'
      ? epochSecondsToIso(sub.current_period_end)
      : null,
    items: data.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as { price?: { id?: unknown }; quantity?: unknown };
      if (typeof candidate.price?.id !== 'string') return [];
      return [{
        priceId: candidate.price.id,
        quantity: typeof candidate.quantity === 'number' ? candidate.quantity : 1,
      }];
    }),
  };
}

function normalizeSubscriptionStatus(value: unknown): BillingEntitlementStatus {
  if (
    value === 'active' ||
    value === 'trialing' ||
    value === 'past_due' ||
    value === 'canceled' ||
    value === 'incomplete' ||
    value === 'unpaid'
  ) {
    return value;
  }
  return 'ended';
}

function epochSecondsToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

export function getPublicBillingPlans() {
  return DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => ({
    slug: plan.slug,
    marketingName: plan.marketingName,
    monthlyUsd: plan.monthlyUsd,
    annualUsd: plan.annualUsd,
    includedRuntimeSlots: plan.includedRuntimeSlots,
  }));
}
