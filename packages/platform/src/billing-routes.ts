import { rememberGoogleAttribution } from './billing/google-attribution-store.js';
import { createStripeWebhookHandler } from './billing/webhook-handler.js';
import { createBillingTrackingRoutes } from './billing/tracking-routes.js';
import { Hono, type Context } from 'hono';
import { createBillingStatusHandler } from './billing-status-route.js';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';

import {
  abandonCreatingCheckoutAttempt,
  claimCardTrialCheckoutAttempt,
  claimCheckoutAttempt,
  finalizeCheckoutAttempt,
  getBillingCustomerByClerkUserId,
  getBillingSubscription,
  getActiveCheckoutAttempt,
  getSettlingCheckoutAttempt,
  resolveCheckoutAttempt,
  upsertBillingEntitlement,
  type PlatformDB,
} from './db.js';
import {
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  resolveServerType,
  type MatrixBillingPlanSlug,
  type MatrixBillingInterval,
} from './billing.js';
import {
  defaultDeveloperToolsForServerType,
  developerToolsAllowedForServerType,
  type DeveloperToolId,
} from './developer-tools.js';

import { loadAiCreditCheckoutConfig } from './ai-credit-checkout.js';

import { createAiCreditCheckoutHandler } from './billing/ai-credit-checkout-route.js';
import { createAiCreditHistoryHandler } from './billing/ai-credit-history-route.js';
import type { RedditConversionsClient } from './reddit-conversions.js';
import { createRedditAttributionExpiry } from './reddit-purchase-attribution.js';

import {
  MAX_STRIPE_API_TIMEOUT_MS,
  type StripeBillingClient,
  type StripeWebhookEvent,
} from './billing/stripe-client.js';
import {
  CheckoutPreparationStatusQuerySchema,
  CheckoutRequestSchema,
  HistoricalBillingRegionSlugSchema,
  MATRIX_CARD_TRIAL_DAYS,
  PortalRequestSchema,
} from './billing/checkout-schemas.js';
import {
  buildCheckoutTelemetryProperties,
  resolveBillingReturnUrl,
  resolveCardTrialDays,
  resolvePriceId,
  resolvePublicRecurringPrice,
  resolveRuntimePlacement,
} from './billing/checkout-support.js';

// S01 / T007: keep the public surface of billing-routes.ts stable for existing consumers.
export { MATRIX_CARD_TRIAL_DAYS } from './billing/checkout-schemas.js';
export type { MarketingAttribution } from './billing/checkout-schemas.js';
export type {
  StripeAiCreditCheckoutSessionInput,
  StripeBillingClient,
  StripeCheckoutSessionInput,
  StripeCheckoutSessionProjection,
  StripeRecurringPriceProjection,
  StripeWebhookEvent,
} from './billing/stripe-client.js';

const BILLING_BODY_LIMIT = 16 * 1024;
const STRIPE_WEBHOOK_BODY_LIMIT = 1024 * 1024;
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
export interface PrebillingCheckoutCoordinator {
  createIntent(input: {
    checkoutAttemptId: string;
    clerkUserId: string;
    runtimeSlot: 'primary';
    planSlug: MatrixBillingPlanSlug;
    billingInterval: MatrixBillingInterval;
    serverType: string;
    regionSlug: string;
    developerTools: DeveloperToolId[];
    now: string;
  }): Promise<{ intentId: string; expiresAt: string } | undefined>;
  startPreparation(input: {
    intentId: string;
    stripeSessionId: string;
    stripeSessionExpiresAt: string;
  }): Promise<boolean>;
  getPreparationStatus(input: {
    checkoutAttemptId: string;
    clerkUserId: string;
  }): Promise<'preparing' | 'ready' | 'failed'>;
  retryPreparation(input: {
    checkoutAttemptId: string;
    clerkUserId: string;
  }): Promise<boolean>;
  resumePreparation(input: {
    intentId: string;
    clerkUserId: string;
  }): Promise<boolean>;
  reconcilePreparations(): Promise<{ checked: number; resumed: number }>;
  authorizeSubscription(
    db: PlatformDB,
    input: { intentId: string; clerkUserId: string; runtimeSlot: string; now: string },
  ): Promise<{ authorized: boolean; machineId: string | null }>;
  expireCheckout(
    db: PlatformDB,
    input: { stripeSessionId: string; intentId?: string; clerkUserId?: string; now: string },
  ): Promise<{ cleaned: boolean; intentId: string | null }>;
}

export function createBillingRoutes(options: {
  db: PlatformDB;
  stripe: StripeBillingClient;
  env?: NodeJS.ProcessEnv;
  resolveClerkUserId: (c: Context) => Promise<string | null>;
  now?: () => Date;
  upsertEntitlement?: typeof upsertBillingEntitlement;
  prebilling?: PrebillingCheckoutCoordinator;
  fundedAiRepository?: Pick<import('./ai-funded-policy-repository.js').AiFundedPolicyRepository,
    'grantCreditInTransaction' | 'getCheckoutFundingSummary'>;
  fundedModelProbes?: import('./ai-funded-model-probes.js').FundedModelProbeService;
  redditConversions?: RedditConversionsClient;
  /**
   * Optional product telemetry sink. Fire-and-forget: implementations must
   * never throw into the request path. Properties are PII-free product facts
   * such as plan, price amounts, runtime placement, and internal machine shape;
   * Stripe object IDs, provider server IDs, and IP addresses stay excluded.
   */
  captureEvent?: (
    event: string,
    options?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ) => void;
}): Hono {
  const app = new Hono();
  const env = options.env ?? process.env;
  const cardTrialDays = resolveCardTrialDays(env);
  const primaryPrebillingRequired = env.CUSTOMER_VPS_ENABLED === 'true'
    && env.MATRIX_BILLING_PROVIDER === 'stripe';
  const now = options.now ?? (() => new Date());
  const persistEntitlement = options.upsertEntitlement ?? upsertBillingEntitlement;
  const aiCreditCheckout = loadAiCreditCheckoutConfig(env);

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

  async function preparedCheckoutResponse(
    c: Context,
    clerkUserId: string,
    attempt: NonNullable<Awaited<ReturnType<typeof getActiveCheckoutAttempt>>>,
    retryFailed = false,
  ) {
    if (attempt.runtimeSlot !== 'primary') {
      if (!attempt.checkoutUrl) throw new Error('checkout_url_missing');
      return c.json({ url: attempt.checkoutUrl }, 200);
    }
    if (!options.prebilling) {
      if (primaryPrebillingRequired) return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
      if (!attempt.checkoutUrl) throw new Error('checkout_url_missing');
      return c.json({ url: attempt.checkoutUrl }, 200);
    }
    let status = await options.prebilling.getPreparationStatus({
      checkoutAttemptId: attempt.id,
      clerkUserId,
    });
    if (status === 'failed' && retryFailed) {
      const restarted = await options.prebilling.retryPreparation({
        checkoutAttemptId: attempt.id,
        clerkUserId,
      });
      if (restarted) {
        status = await options.prebilling.getPreparationStatus({
          checkoutAttemptId: attempt.id,
          clerkUserId,
        });
      }
    }
    if (status === 'preparing') {
      return c.json({ status: 'preparing', attemptId: attempt.id }, 202);
    }
    if (status !== 'ready' || !attempt.checkoutUrl) {
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }
    return c.json({ url: attempt.checkoutUrl }, 200);
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

    const selectedPlan = DEFAULT_BILLING_PLAN_DEFINITIONS.find((plan) => plan.slug === parsed.data.planSlug);
    const serverType = selectedPlan
      ? resolveServerType(loadRuntimeCatalog(env), selectedPlan.defaultCatalogSku, parsed.data.regionSlug)
        ?? undefined
      : undefined;
    const developerToolsWereOmitted = typeof body === 'object'
      && body !== null
      && !Object.hasOwn(body, 'developerTools');
    const developerTools = developerToolsWereOmitted && serverType
      ? defaultDeveloperToolsForServerType(serverType)
      : parsed.data.developerTools;

    const checkoutProperties = buildCheckoutTelemetryProperties({ ...parsed.data, developerTools });
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

    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error('stripe_timeout_exceeds_budget');
      }
      const currentTime = now();
      const existingSubscription = await getBillingSubscription(
        options.db,
        clerkUserId,
        parsed.data.runtimeSlot,
        currentTime.toISOString(),
      );
      if (existingSubscription) {
        const existingEntitlement = deriveStripeEntitlement({
          clerkUserId: existingSubscription.clerkUserId,
          stripeCustomerId: existingSubscription.stripeCustomerId,
          stripeSubscriptionId: existingSubscription.stripeSubscriptionId,
          status: existingSubscription.status,
          currentPeriodEnd: existingSubscription.currentPeriodEnd,
          trialStartedAt: existingSubscription.trialStartedAt,
          trialEndsAt: existingSubscription.trialEndsAt,
          trialConvertedAt: existingSubscription.trialConvertedAt,
          firstTrialPaymentFailedAt: existingSubscription.firstTrialPaymentFailedAt,
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
      if (parsed.data.serverType && parsed.data.serverType !== serverType) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      if (serverType && !developerToolsAllowedForServerType(serverType, developerTools)) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      if (primaryPrebillingRequired && parsed.data.runtimeSlot === 'primary' && !options.prebilling) {
        return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
      }
      const checkoutClaim = {
        clerkUserId,
        createdAt: currentTime.toISOString(),
        developerTools,
        runtimeSlot: parsed.data.runtimeSlot,
        planSlug: parsed.data.planSlug,
        billingInterval: parsed.data.interval,
        regionSlug: parsed.data.regionSlug,
        ...(serverType ? { serverType } : {}),
      };
      const claimAttempt = () => env.MATRIX_CARD_TRIALS_ENABLED === 'true'
        && parsed.data.runtimeSlot === 'primary'
        ? claimCardTrialCheckoutAttempt(options.db, {
            id: randomUUID(),
            ...checkoutClaim,
          }, cardTrialDays)
        : claimCheckoutAttempt(options.db, {
            id: randomUUID(),
            ...checkoutClaim,
            trialPeriodDays: null,
          });
      let attempt = await claimAttempt();
      if (!attempt.claimed) {
        const isLegacyOpenAttempt = attempt.attempt.status === 'open'
          && attempt.attempt.stripeSessionId !== null
          && (
            !attempt.attempt.planSlug
            || !attempt.attempt.billingInterval
            || !attempt.attempt.regionSlug
          );
        if (isLegacyOpenAttempt) {
          const legacyStripeSessionId = attempt.attempt.stripeSessionId;
          if (!legacyStripeSessionId) throw new Error('checkout_session_id_missing');
          const session = await options.stripe.retrieveCheckoutSession(legacyStripeSessionId);
          if (session.clerkUserId !== clerkUserId) {
            throw new Error('checkout_session_owner_mismatch');
          }
          if (session.status === 'complete') {
            await resolveCheckoutAttempt(
              options.db,
              legacyStripeSessionId,
              'paid',
              currentTime.toISOString(),
            );
            return c.json({ error: 'Checkout is already starting', code: 'checkout_pending' }, 409);
          }
          if (session.status === 'expired') {
            await resolveCheckoutAttempt(
              options.db,
              legacyStripeSessionId,
              'expired',
              currentTime.toISOString(),
            );
            attempt = await claimAttempt();
          } else {
            const recoveredPlan = session.priceId
              ? loadStripePriceCatalog(env).priceToPlan.get(session.priceId)
              : undefined;
            const recoveredRegion = HistoricalBillingRegionSlugSchema.safeParse(session.regionSlug);
            if (!session.url || !recoveredPlan || !recoveredRegion.success) {
              throw new Error('checkout_session_selection_missing');
            }
            if (
              recoveredPlan.planSlug === parsed.data.planSlug
              && recoveredPlan.interval === parsed.data.interval
              && recoveredRegion.data === parsed.data.regionSlug
            ) {
              return c.json({ url: session.url }, 200);
            }
            return c.json({
              error: 'Checkout selection conflicts with an open session',
              code: 'checkout_selection_conflict',
              selection: {
                planSlug: recoveredPlan.planSlug,
                interval: recoveredPlan.interval,
                regionSlug: recoveredRegion.data,
              },
            }, 409);
          }
        }
      }
      if (!attempt.claimed) {
        if (attempt.selectionMatches && attempt.attempt.status === 'open' && attempt.attempt.checkoutUrl) {
          return c.json({ url: attempt.attempt.checkoutUrl }, 200);
        }
        if (
          !attempt.selectionMatches
          && attempt.attempt.status === 'open'
          && attempt.attempt.planSlug
          && attempt.attempt.billingInterval
          && attempt.attempt.regionSlug
        ) {
          return c.json({
            error: 'Checkout selection conflicts with an open session',
            code: 'checkout_selection_conflict',
            selection: {
              planSlug: attempt.attempt.planSlug,
              interval: attempt.attempt.billingInterval,
              regionSlug: attempt.attempt.regionSlug,
            },
          }, 409);
        }
        return c.json({
          error: 'Checkout is already starting',
          code: 'checkout_pending',
        }, 409);
      }
      const customer = await getBillingCustomerByClerkUserId(options.db, clerkUserId);
      let preparation: { intentId: string; expiresAt: string } | undefined;
      if (options.prebilling && serverType && parsed.data.runtimeSlot === 'primary') {
        try {
          preparation = await options.prebilling.createIntent({
            checkoutAttemptId: attempt.attempt.id,
            clerkUserId,
            runtimeSlot: 'primary',
            planSlug: parsed.data.planSlug,
            billingInterval: parsed.data.interval,
            serverType,
            regionSlug: parsed.data.regionSlug,
            developerTools,
            now: currentTime.toISOString(),
          });
        } catch (err: unknown) {
          console.warn('[billing] prebilling intent unavailable:', err instanceof Error ? err.name : typeof err);
        }
      }
      if (options.prebilling && parsed.data.runtimeSlot === 'primary' && !preparation) {
        await abandonCreatingCheckoutAttempt(options.db, attempt.attempt.id, currentTime.toISOString());
        return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
      }
      const googleAnalytics = await rememberGoogleAttribution(options.db, attempt.attempt.id, clerkUserId,
        parsed.data.googleAnalytics, currentTime.toISOString());
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
        redditAttributionExpiresAt: createRedditAttributionExpiry(
          attempt.attempt.createdAt,
          attempt.attempt.trialPeriodDays,
        ),
        trialPeriodDays: attempt.attempt.trialPeriodDays,
        paymentMethodMode: attempt.attempt.trialPeriodDays ? 'card_required' : 'dynamic',
        ...(preparation ? {
          prebillingIntentId: preparation.intentId,
          expiresAt: preparation.expiresAt,
        } : {}),
        attribution: parsed.data.attribution,
        googleAnalytics,
        planSlug: parsed.data.planSlug,
        interval: parsed.data.interval,
        successUrl: resolveBillingReturnUrl(env, 'success', parsed.data.returnPath),
        cancelUrl: resolveBillingReturnUrl(env, 'canceled', parsed.data.returnPath),
      });
      if (!await finalizeCheckoutAttempt(options.db, attempt.attempt.id, session.id, session.url)) {
        throw new Error('checkout_attempt_finalize_failed');
      }
      if (preparation) {
        try {
          const started = await options.prebilling?.startPreparation({
            intentId: preparation.intentId,
            stripeSessionId: session.id,
            stripeSessionExpiresAt: session.expiresAt ?? preparation.expiresAt,
          });
          if (!started) {
            console.warn('[billing] prebilling preparation deferred');
          }
        } catch (err: unknown) {
          console.warn('[billing] prebilling preparation unavailable:', err instanceof Error ? err.name : typeof err);
        }
      }
      emitTelemetry(BILLING_CHECKOUT_CREATED_EVENT, {
        distinctId: clerkUserId,
        properties: checkoutProperties,
      });
      return c.json({ url: session.url }, 200);
    } catch (err: unknown) {
      console.error('[billing] checkout creation failed:', err instanceof Error ? err.message : String(err));
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

  app.get('/ai-credit/history', createAiCreditHistoryHandler({
    db: options.db,
    resolveClerkUserId: (c) => resolveRouteClerkUserId(c, 'ai-credit history'),
  }));

  app.post('/ai-credit/checkout', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), createAiCreditCheckoutHandler({
    db: options.db,
    stripe: options.stripe,
    env,
    checkout: aiCreditCheckout,
    fundedAiRepository: options.fundedAiRepository,
    fundedModelProbes: options.fundedModelProbes,
    resolveClerkUserId: (c) => resolveRouteClerkUserId(c, 'ai-credit checkout'),
    now,
    unavailableResponse: BILLING_UNAVAILABLE_RESPONSE,
  }));

  app.get('/checkout/status', async (c) => {
    const clerkUserId = await resolveRouteClerkUserId(c, 'checkout status');
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = CheckoutPreparationStatusQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const attempt = await getActiveCheckoutAttempt(options.db, clerkUserId, 'primary');
      if (!attempt || attempt.id !== parsed.data.attemptId) {
        return c.json({ error: 'Checkout unavailable' }, 404);
      }
      return preparedCheckoutResponse(c, clerkUserId, attempt);
    } catch (err: unknown) {
      console.error('[billing] checkout status failed:', err instanceof Error ? err.name : typeof err);
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

  app.route('/', createBillingTrackingRoutes({ ...options, resolveClerkUserId: (c) => resolveRouteClerkUserId(c, 'tracking') }));

  app.get('/status', createBillingStatusHandler({
    db: options.db,
    stripe: options.stripe,
    env,
    now,
    cardTrialDays,
    resolveClerkUserId: (c) => resolveRouteClerkUserId(c, 'status'),
    resolvePublicRecurringPrice,
    resolveRuntimePlacement,
  }));

  app.post('/webhooks/stripe', bodyLimit({ maxSize: STRIPE_WEBHOOK_BODY_LIMIT }), createStripeWebhookHandler(options, emitTelemetry));

  app.all('*', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), (c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  return app;
}

export function getPublicBillingPlans() {
  return DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => ({
    slug: plan.slug,
    marketingName: plan.marketingName,
    monthlyUsd: plan.monthlyUsd,
    includedRuntimeSlots: plan.includedRuntimeSlots,
  }));
}
