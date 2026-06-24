import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { z } from 'zod/v4';
import { appOrigin, resolveReturnPath } from './origins.js';
import {
  getBillingCustomerByClerkUserId,
  getBillingCustomerByStripeCustomerId,
  getBillingEntitlement,
  getBillingEntitlementState,
  insertBillingWebhookEvent,
  insertCheckoutAttempt,
  resolveCheckoutAttempt,
  runBillingWebhookTransaction,
  upsertBillingCustomer,
  upsertBillingEntitlement,
  type PlatformDB,
} from './db.js';
import {
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  computeEffectiveEntitlement,
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  parseBillingEntitlementRecord,
  parseBillingOverrideRecord,
  type BillingEntitlementStatus,
  type MatrixBillingPlanSlug,
  type MatrixBillingInterval,
  type StripeSubscriptionProjection,
} from './billing.js';
import { DeveloperToolsWithDefaultSchema } from './developer-tools.js';

const BILLING_BODY_LIMIT = 16 * 1024;
const STRIPE_WEBHOOK_BODY_LIMIT = 1024 * 1024;
const MAX_STRIPE_API_TIMEOUT_MS = 10_000;
const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]{1,128}$/;
const BILLING_UNAVAILABLE_RESPONSE = {
  error: 'Billing unavailable',
  code: 'billing_unavailable',
} as const;

const CheckoutRequestSchema = z.object({
  planSlug: z.enum(['matrix_starter', 'matrix_builder', 'matrix_max']),
  interval: z.enum(['monthly', 'annual']).default('monthly'),
  regionSlug: z.enum(['region_fsn1', 'region_nbg1', 'region_ash', 'region_hil']).default('region_fsn1'),
  developerTools: DeveloperToolsWithDefaultSchema,
  returnPath: z.string().min(1).max(2048).optional().refine(
    // Safe iff it is already a same-origin allowlisted path (origins.ts is the
    // single source of truth for redirect-target validation).
    (value) => value === undefined || resolveReturnPath(value) === value,
    { message: 'Invalid return path' },
  ),
});

export interface StripeCheckoutSessionInput {
  clerkUserId: string;
  customerId?: string;
  priceId: string;
  mode: 'subscription';
  automaticTax: boolean;
  allowPromotionCodes: boolean;
  regionSlug: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeBillingClient {
  apiTimeoutMs: number;
  /**
   * Implementations must use a bounded network timeout. Checkout creates the
   * Stripe Customer when needed; the signed subscription webhook links it back
   * to the Clerk user from server-written metadata.
   */
  createCheckoutSession(input: StripeCheckoutSessionInput): Promise<{ url: string; id: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
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
  /**
   * Optional product telemetry sink. Fire-and-forget: implementations must
   * never throw into the request path, and callers only pass low-cardinality,
   * PII-free properties (reason codes and Stripe event types).
   */
  captureEvent?: (
    event: string,
    options?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ) => void;
}): Hono {
  const app = new Hono();
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const persistEntitlement = options.upsertEntitlement ?? upsertBillingEntitlement;

  function emitTelemetry(
    event: string,
    captureOptions?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ): void {
    if (!options.captureEvent) return;
    try {
      options.captureEvent(event, captureOptions);
    } catch (err: unknown) {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[billing] telemetry capture failed for ${event}: ${kind}`);
    }
  }

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
    if (!priceId) return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);

    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error('stripe_timeout_exceeds_budget');
      }
      const customer = await getBillingCustomerByClerkUserId(options.db, clerkUserId);
      const session = await options.stripe.createCheckoutSession({
        clerkUserId,
        customerId: customer?.stripeCustomerId,
        priceId,
        mode: 'subscription',
        automaticTax: true,
        allowPromotionCodes: true,
        regionSlug: parsed.data.regionSlug,
        successUrl: resolveBillingReturnUrl(env, 'success', parsed.data.returnPath),
        cancelUrl: resolveBillingReturnUrl(env, 'canceled', parsed.data.returnPath),
      });
      // Record the attempt so the journey can derive payment_settling without a
      // client-side marker. Best-effort: never block the user's checkout on it.
      try {
        await insertCheckoutAttempt(options.db, {
          id: randomUUID(),
          clerkUserId,
          stripeSessionId: session.id,
          createdAt: now().toISOString(),
          developerTools: parsed.data.developerTools,
        });
      } catch (err: unknown) {
        console.error('[billing] checkout attempt record failed:', err instanceof Error ? err.message : String(err));
      }
      return c.json({ url: session.url }, 200);
    } catch (err: unknown) {
      console.error('[billing] checkout creation failed:', err instanceof Error ? err.message : String(err));
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
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
      const session = await options.stripe.createPortalSession({
        customerId: customer.stripeCustomerId,
        returnUrl: resolveBillingReturnUrl(env, 'portal'),
      });
      return c.json({ url: session.url }, 200);
    } catch (err: unknown) {
      console.error('[billing] portal creation failed:', err instanceof Error ? err.message : String(err));
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }
  });

  app.get('/status', async (c) => {
    const clerkUserId = await resolveRouteClerkUserId(c, 'status');
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const currentTime = now();
      const state = await getBillingEntitlementState(options.db, clerkUserId, currentTime.toISOString());
      const entitlement = computeEffectiveEntitlement({
        stripeEntitlement: parseBillingEntitlementRecord(state.entitlement),
        override: parseBillingOverrideRecord(state.override),
        now: currentTime,
      });
      const access = getRuntimeAccessDecision(entitlement, currentTime);
      return c.json({ entitlement, access }, 200);
    } catch (err: unknown) {
      console.error('[billing] status lookup failed:', err instanceof Error ? err.message : String(err));
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
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
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.BILLING_WEBHOOK_FAILED, {
        properties: { reason: 'invalid_signature' },
      });
      return c.json({ error: 'Invalid webhook' }, 400);
    }

    try {
      const webhookProcessedAt = now();
      const result = await runBillingWebhookTransaction(options.db, async (trx) => {
        const inserted = await insertBillingWebhookEvent(trx, {
          stripeEventId: event.id,
          eventType: event.type,
          createdAtFromStripe: epochSecondsToIso(event.created),
          processedAt: webhookProcessedAt.toISOString(),
          status: 'processed',
          errorCode: null,
        });
        if (!inserted.inserted) {
          return { received: true, duplicate: true };
        }

        // Checkout session lifecycle drives the settling-attempt status: a
        // confirmed payment marks the attempt `paid` (sticky), an expiry marks
        // it `expired`. Both only transition `open` rows.
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
          const sessionId = readStripeObjectId(event.data.object);
          if (sessionId) {
            await resolveCheckoutAttempt(
              trx,
              sessionId,
              event.type === 'checkout.session.completed' ? 'paid' : 'expired',
              webhookProcessedAt.toISOString(),
            );
          }
          return { received: true, processed: true };
        }

        if (!isSubscriptionEvent(event.type)) {
          return { received: true, ignored: true };
        }

        const projection = await projectSubscription(trx, event.data.object, webhookProcessedAt);
        if (!projection) return { received: true, ignored: true };

        const entitlement = deriveStripeEntitlement(projection, {
          priceCatalog: loadStripePriceCatalog(env),
          runtimeCatalog: loadRuntimeCatalog(env),
          now: webhookProcessedAt,
        });
        await persistEntitlement(trx, entitlement);
        return { received: true, processed: true };
      });
      return c.json(result, 200);
    } catch (err: unknown) {
      console.error('[billing] Stripe webhook processing failed:', err instanceof Error ? err.message : String(err));
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.BILLING_WEBHOOK_FAILED, {
        properties: { reason: 'processing_error', event_type: event.type },
      });
      return c.json({ error: 'Webhook processing failed' }, 500);
    }
  });

  app.all('*', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), (c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  return app;
}

function resolvePriceId(
  env: NodeJS.ProcessEnv,
  planSlug: MatrixBillingPlanSlug,
  interval: MatrixBillingInterval,
): string | undefined {
  const key = `STRIPE_PRICE_${planSlug.toUpperCase()}_${interval.toUpperCase()}`;
  return env[key];
}

function resolveBillingReturnUrl(
  env: NodeJS.ProcessEnv,
  state: 'success' | 'canceled' | 'portal',
  returnPath?: string,
): string {
  const appUrl = appOrigin(env);
  if (returnPath && state !== 'portal') {
    const appBase = new URL(appUrl);
    // resolveReturnPath is the authoritative allowlist guard — never build the
    // redirect from the raw client path (off-allowlist values collapse to "/").
    const url = new URL(resolveReturnPath(returnPath), appBase.origin);
    url.searchParams.set('billing', state);
    if (state === 'success') url.searchParams.set('checkout', 'success');
    return url.toString();
  }
  if (state === 'success' && env.STRIPE_CHECKOUT_SUCCESS_URL) return env.STRIPE_CHECKOUT_SUCCESS_URL;
  if (state === 'canceled' && env.STRIPE_CHECKOUT_CANCEL_URL) return env.STRIPE_CHECKOUT_CANCEL_URL;
  if (state === 'portal' && env.STRIPE_PORTAL_RETURN_URL) return env.STRIPE_PORTAL_RETURN_URL;
  const url = new URL(appUrl);
  url.searchParams.set('billing', state);
  if (state === 'success') url.searchParams.set('checkout', 'success');
  return url.toString();
}

function isSubscriptionEvent(type: string): boolean {
  return (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  );
}

async function projectSubscription(
  db: PlatformDB,
  value: unknown,
  currentTime: Date,
): Promise<StripeSubscriptionProjection | null> {
  if (!value || typeof value !== 'object') return null;
  const sub = value as {
    id?: unknown;
    customer?: unknown;
    status?: unknown;
    current_period_end?: unknown;
    metadata?: unknown;
    items?: { data?: unknown };
  };
  if (typeof sub.id !== 'string' || typeof sub.customer !== 'string') return null;
  let customer = await getBillingCustomerByStripeCustomerId(db, sub.customer);
  if (!customer) {
    const clerkUserId = readClerkUserIdFromStripeMetadata(sub.metadata);
    if (!clerkUserId) return null;
    const nowIso = currentTime.toISOString();
    await upsertBillingCustomer(db, {
      clerkUserId,
      stripeCustomerId: sub.customer,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    customer = await getBillingCustomerByStripeCustomerId(db, sub.customer);
    if (!customer) return null;
  }
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

function readStripeObjectId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readClerkUserIdFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const clerkUserId = (metadata as { clerk_user_id?: unknown }).clerk_user_id;
  return typeof clerkUserId === 'string' && CLERK_USER_ID_PATTERN.test(clerkUserId)
    ? clerkUserId
    : null;
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
