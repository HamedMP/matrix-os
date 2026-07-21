import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { z } from 'zod/v4';
import { appOrigin, resolveReturnPath } from './origins.js';
import {
  abandonCreatingCheckoutAttempt,
  claimCheckoutAttempt,
  finalizeCheckoutAttempt,
  getBillingCustomerByClerkUserId,
  getBillingCustomerByStripeCustomerId,
  getBillingEntitlement,
  getBillingEntitlementState,
  getBillingSubscription,
  getSettlingCheckoutAttempt,
  insertBillingWebhookEvent,
  resolveCheckoutAttempt,
  runBillingWebhookTransaction,
  listCurrentBillingSubscriptions,
  upsertBillingCustomer,
  upsertBillingEntitlement,
  upsertBillingSubscription,
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
  type BillingEntitlement,
  type MatrixBillingPlanSlug,
  type MatrixBillingInterval,
  type StripePriceCatalog,
  type StripeSubscriptionProjection,
} from './billing.js';
import { DeveloperToolsWithDefaultSchema } from './developer-tools.js';
import { RuntimeSlotSchema } from './customer-vps-schema.js';

const BILLING_BODY_LIMIT = 16 * 1024;
const STRIPE_WEBHOOK_BODY_LIMIT = 1024 * 1024;
const MAX_STRIPE_API_TIMEOUT_MS = 10_000;
const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]{1,128}$/;
const BILLING_UNAVAILABLE_RESPONSE = {
  error: 'Billing unavailable',
  code: 'billing_unavailable',
} as const;
const BILLING_CHECKOUT_STARTED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_STARTED ?? 'matrix_billing_checkout_started';
const BILLING_CHECKOUT_CREATED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_CREATED ?? 'matrix_billing_checkout_created';
const BILLING_CHECKOUT_FAILED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_FAILED ?? 'matrix_billing_checkout_failed';
const BILLING_CHECKOUT_COMPLETED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_COMPLETED ?? 'matrix_billing_checkout_completed';
const BILLING_CHECKOUT_EXPIRED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_EXPIRED ?? 'matrix_billing_checkout_expired';
const BILLING_SUBSCRIPTION_UPDATED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_SUBSCRIPTION_UPDATED ?? 'matrix_billing_subscription_updated';

const CheckoutRequestSchema = z.object({
  planSlug: z.enum(['matrix_starter', 'matrix_builder', 'matrix_max']),
  interval: z.enum(['monthly', 'annual']).default('monthly'),
  regionSlug: z.enum(['region_fsn1', 'region_nbg1', 'region_ash', 'region_hil']).default('region_fsn1'),
  developerTools: DeveloperToolsWithDefaultSchema,
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
  returnPath: z.string().min(1).max(2048).optional().refine(
    // Safe iff it is already a same-origin allowlisted path (origins.ts is the
    // single source of truth for redirect-target validation).
    (value) => value === undefined || resolveReturnPath(value) === value,
    { message: 'Invalid return path' },
  ),
});
type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

const PortalRequestSchema = z.object({
  intent: z.literal('manage').default('manage'),
  returnPath: z.string().min(1).max(2048).optional().refine(
    (value) => value === undefined || resolveReturnPath(value) === value,
    { message: 'Invalid return path' },
  ),
}).strict();

const BillingStatusQuerySchema = z.object({
  runtimeSlot: RuntimeSlotSchema.optional(),
}).strict();

export interface StripeCheckoutSessionInput {
  idempotencyKey: string;
  clerkUserId: string;
  customerId?: string;
  priceId: string;
  mode: 'subscription';
  automaticTax: boolean;
  allowPromotionCodes: boolean;
  regionSlug: string;
  runtimeSlot: string;
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
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
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

    const checkoutProperties = buildCheckoutTelemetryProperties(parsed.data);
    emitTelemetry(BILLING_CHECKOUT_STARTED_EVENT, {
      distinctId: clerkUserId,
      properties: checkoutProperties,
    });

    const priceId = resolvePriceId(env, parsed.data.planSlug, parsed.data.interval);
    if (!priceId) {
      emitTelemetry(BILLING_CHECKOUT_FAILED_EVENT, {
        distinctId: clerkUserId,
        properties: {
          ...checkoutProperties,
          failure_code: 'missing_price_config',
          http_status: 503,
        },
      });
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }

    let claimedAttemptId: string | null = null;
    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error('stripe_timeout_exceeds_budget');
      }
      const currentTime = now();
      const existingSubscription = await getBillingSubscription(
        options.db,
        clerkUserId,
        parsed.data.runtimeSlot,
      );
      if (existingSubscription) {
        const existingEntitlement = deriveStripeEntitlement({
          clerkUserId: existingSubscription.clerkUserId,
          stripeCustomerId: existingSubscription.stripeCustomerId,
          stripeSubscriptionId: existingSubscription.stripeSubscriptionId,
          status: existingSubscription.status,
          currentPeriodEnd: existingSubscription.currentPeriodEnd,
          items: [{ priceId: existingSubscription.stripePriceId, quantity: 1 }],
        }, {
          priceCatalog: loadStripePriceCatalog(env),
          runtimeCatalog: loadRuntimeCatalog(env),
          now: currentTime,
        });
        if (getRuntimeAccessDecision(existingEntitlement, currentTime).runtimeProxyAllowed) {
          return c.json({
            error: 'Computer already has billing',
            code: 'runtime_already_subscribed',
          }, 409);
        }
      }
      const settlingAttempt = await getSettlingCheckoutAttempt(
        options.db,
        clerkUserId,
        parsed.data.runtimeSlot,
      );
      if (
        settlingAttempt?.status === 'paid'
        && (
          !existingSubscription
          || Date.parse(settlingAttempt.createdAt) > Date.parse(existingSubscription.latestEventCreatedAt)
        )
      ) {
        return c.json({ error: 'Checkout is already starting', code: 'checkout_pending' }, 409);
      }
      const selectedPlan = DEFAULT_BILLING_PLAN_DEFINITIONS.find((plan) => plan.slug === parsed.data.planSlug);
      const serverType = selectedPlan
        ? loadRuntimeCatalog(env).profiles.find((profile) => profile.sku === selectedPlan.defaultCatalogSku)?.serverType
        : undefined;
      const attempt = await claimCheckoutAttempt(options.db, {
        id: randomUUID(),
        clerkUserId,
        createdAt: currentTime.toISOString(),
        developerTools: parsed.data.developerTools,
        runtimeSlot: parsed.data.runtimeSlot,
        planSlug: parsed.data.planSlug,
        billingInterval: parsed.data.interval,
        regionSlug: parsed.data.regionSlug,
        ...(serverType ? { serverType } : {}),
      });
      if (!attempt.claimed) {
        if (attempt.attempt.status === 'open' && attempt.attempt.checkoutUrl) {
          return c.json({ url: attempt.attempt.checkoutUrl }, 200);
        }
        return c.json({ error: 'Checkout is already starting', code: 'checkout_pending' }, 409);
      }
      claimedAttemptId = attempt.attempt.id;
      const customer = await getBillingCustomerByClerkUserId(options.db, clerkUserId);
      const session = await options.stripe.createCheckoutSession({
        idempotencyKey: attempt.attempt.id,
        clerkUserId,
        customerId: customer?.stripeCustomerId,
        priceId,
        mode: 'subscription',
        automaticTax: true,
        allowPromotionCodes: true,
        regionSlug: parsed.data.regionSlug,
        runtimeSlot: parsed.data.runtimeSlot,
        successUrl: resolveBillingReturnUrl(env, 'success', parsed.data.returnPath),
        cancelUrl: resolveBillingReturnUrl(env, 'canceled', parsed.data.returnPath),
      });
      if (!await finalizeCheckoutAttempt(options.db, attempt.attempt.id, session.id, session.url)) {
        throw new Error('checkout_attempt_finalize_failed');
      }
      emitTelemetry(BILLING_CHECKOUT_CREATED_EVENT, {
        distinctId: clerkUserId,
        properties: checkoutProperties,
      });
      return c.json({ url: session.url }, 200);
    } catch (err: unknown) {
      console.error('[billing] checkout creation failed:', err instanceof Error ? err.message : String(err));
      if (claimedAttemptId) {
        try {
          await abandonCreatingCheckoutAttempt(options.db, claimedAttemptId, now().toISOString());
        } catch (cleanupError: unknown) {
          console.error('[billing] checkout attempt cleanup failed:', cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      }
      emitTelemetry(BILLING_CHECKOUT_FAILED_EVENT, {
        distinctId: clerkUserId,
        properties: {
          ...checkoutProperties,
          failure_code: 'stripe_unavailable',
          http_status: 503,
        },
      });
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }
  });

  app.post('/portal', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), async (c) => {
    const clerkUserId = await resolveRouteClerkUserId(c, 'portal');
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);

    let rawBody: unknown = {};
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      try {
        rawBody = JSON.parse(raw);
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError)) throw err;
        return c.json({ error: 'Invalid request' }, 400);
      }
    }
    const parsed = PortalRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);

    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error('stripe_timeout_exceeds_budget');
      }
      const customer = await getBillingCustomerByClerkUserId(options.db, clerkUserId);
      if (!customer) return c.json({ error: 'Billing unavailable' }, 404);
      const session = await options.stripe.createPortalSession({
        customerId: customer.stripeCustomerId,
        returnUrl: resolveBillingReturnUrl(env, 'portal', parsed.data.returnPath),
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
      const query = BillingStatusQuerySchema.safeParse(c.req.query());
      if (!query.success) return c.json({ error: 'Invalid request' }, 400);
      const state = await getBillingEntitlementState(options.db, clerkUserId, currentTime.toISOString());
      let stripeEntitlement = parseBillingEntitlementRecord(state.entitlement);
      if (query.data.runtimeSlot) {
        const subscription = await getBillingSubscription(options.db, clerkUserId, query.data.runtimeSlot);
        stripeEntitlement = subscription
          ? deriveStripeEntitlement({
            clerkUserId: subscription.clerkUserId,
            stripeCustomerId: subscription.stripeCustomerId,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
            items: [{ priceId: subscription.stripePriceId, quantity: 1 }],
          }, {
            priceCatalog: loadStripePriceCatalog(env),
            runtimeCatalog: loadRuntimeCatalog(env),
            now: currentTime,
          })
          : null;
      }
      const entitlement = computeEffectiveEntitlement({
        stripeEntitlement,
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
          emitTelemetry(
            event.type === 'checkout.session.completed'
              ? BILLING_CHECKOUT_COMPLETED_EVENT
              : BILLING_CHECKOUT_EXPIRED_EVENT,
            {
              distinctId: readClerkUserIdFromCheckoutSession(event.data.object) ?? undefined,
              properties: { stripe_event_type: event.type },
            },
          );
          return { received: true, processed: true };
        }

        if (!isSubscriptionEvent(event.type)) {
          return { received: true, ignored: true };
        }

        const projection = await projectSubscription(trx, event.data.object, webhookProcessedAt);
        if (!projection) return { received: true, ignored: true };

        const priceCatalog = loadStripePriceCatalog(env);
        const entitlement = deriveStripeEntitlement(projection, {
          priceCatalog,
          runtimeCatalog: loadRuntimeCatalog(env),
          now: webhookProcessedAt,
        });
        const priceEntry = entitlement.stripePriceId
          ? priceCatalog.priceToPlan.get(entitlement.stripePriceId)
          : undefined;
        if (!priceEntry || !entitlement.stripePriceId) {
          return { received: true, ignored: true };
        }
        await upsertBillingSubscription(trx, {
          stripeSubscriptionId: projection.stripeSubscriptionId,
          stripeCustomerId: projection.stripeCustomerId,
          clerkUserId: projection.clerkUserId,
          runtimeSlot: projection.runtimeSlot,
          planSlug: priceEntry.planSlug,
          stripePriceId: entitlement.stripePriceId,
          billingInterval: priceEntry.interval,
          status: entitlement.status,
          currentPeriodEnd: projection.currentPeriodEnd ?? null,
          gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
          latestEventCreatedAt: epochSecondsToIso(event.created),
          latestEventId: event.id,
          updatedAt: webhookProcessedAt.toISOString(),
        });
        const summary = await recomputeStripeSummary(trx, projection.clerkUserId, priceCatalog, env, webhookProcessedAt);
        if (summary) await persistEntitlement(trx, summary);
        emitTelemetry(BILLING_SUBSCRIPTION_UPDATED_EVENT, {
          distinctId: entitlement.clerkUserId,
          properties: buildSubscriptionTelemetryProperties(entitlement, priceCatalog),
        });
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

function buildCheckoutTelemetryProperties(data: CheckoutRequest): Record<string, string | number | boolean | undefined> {
  return {
    plan_slug: data.planSlug,
    billing_interval: data.interval,
    region_slug: data.regionSlug,
    return_path_present: Boolean(data.returnPath),
    developer_tools_count: data.developerTools.length,
    price_usd: planPriceUsd(data.planSlug, data.interval),
  };
}

function buildSubscriptionTelemetryProperties(
  entitlement: BillingEntitlement,
  priceCatalog: StripePriceCatalog,
): Record<string, string | number | boolean | undefined> {
  const interval = entitlement.stripePriceId
    ? priceCatalog.priceToPlan.get(entitlement.stripePriceId)?.interval
    : undefined;
  const planSlug = entitlement.planSlug === 'internal' ? undefined : entitlement.planSlug;
  return {
    plan_slug: planSlug,
    subscription_status: entitlement.status,
    billing_interval: interval,
    price_usd: planSlug && interval ? planPriceUsd(planSlug, interval) : undefined,
    included_runtime_slots: entitlement.includedRuntimeSlots,
    addon_runtime_slots: entitlement.addonRuntimeSlots,
    max_runtime_slots: entitlement.maxRuntimeSlots,
  };
}

function planPriceUsd(planSlug: MatrixBillingPlanSlug, interval: MatrixBillingInterval): number | undefined {
  const plan = DEFAULT_BILLING_PLAN_DEFINITIONS.find((candidate) => candidate.slug === planSlug);
  if (!plan) return undefined;
  return interval === 'annual' ? plan.annualUsd : plan.monthlyUsd;
}

function resolveBillingReturnUrl(
  env: NodeJS.ProcessEnv,
  state: 'success' | 'canceled' | 'portal',
  returnPath?: string,
): string {
  const appUrl = appOrigin(env);
  if (returnPath && state === 'portal') {
    return new URL(resolveReturnPath(returnPath), new URL(appUrl).origin).toString();
  }
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
): Promise<(StripeSubscriptionProjection & { runtimeSlot: string }) | null> {
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
  const runtimeSlot = readRuntimeSlotFromStripeMetadata(sub.metadata) ?? 'primary';
  const data = Array.isArray(sub.items?.data) ? sub.items.data : [];
  return {
    clerkUserId: customer.clerkUserId,
    stripeCustomerId: customer.stripeCustomerId,
    stripeSubscriptionId: sub.id,
    runtimeSlot,
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

function readRuntimeSlotFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = RuntimeSlotSchema.safeParse((metadata as { matrix_runtime_slot?: unknown }).matrix_runtime_slot);
  return parsed.success ? parsed.data : null;
}

async function recomputeStripeSummary(
  db: PlatformDB,
  clerkUserId: string,
  priceCatalog: StripePriceCatalog,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<BillingEntitlement | null> {
  const subscriptions = await listCurrentBillingSubscriptions(db, clerkUserId);
  if (subscriptions.length === 0) return null;
  const runtimeCatalog = loadRuntimeCatalog(env);
  const projected = subscriptions.map((subscription) => ({
    runtimeSlot: subscription.runtimeSlot,
    entitlement: deriveStripeEntitlement({
      clerkUserId: subscription.clerkUserId,
      stripeCustomerId: subscription.stripeCustomerId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      items: [{ priceId: subscription.stripePriceId, quantity: 1 }],
    }, { priceCatalog, runtimeCatalog, now }),
  }));
  const accessible = projected.filter(({ entitlement }) => getRuntimeAccessDecision(entitlement, now).runtimeProxyAllowed);
  const representative = accessible.find(({ runtimeSlot }) => runtimeSlot === 'primary')
    ?? accessible[0]
    ?? projected.find(({ runtimeSlot }) => runtimeSlot === 'primary')
    ?? projected[0];
  if (!representative) return null;
  return {
    ...representative.entitlement,
    maxRuntimeSlots: accessible.length,
    includedRuntimeSlots: accessible.length,
    addonRuntimeSlots: 0,
    updatedAt: now.toISOString(),
  };
}

function readStripeObjectId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readClerkUserIdFromCheckoutSession(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as { client_reference_id?: unknown; metadata?: unknown };
  if (typeof session.client_reference_id === 'string' && CLERK_USER_ID_PATTERN.test(session.client_reference_id)) {
    return session.client_reference_id;
  }
  return readClerkUserIdFromStripeMetadata(session.metadata);
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
