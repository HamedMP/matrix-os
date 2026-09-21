/**
 * Billing checkout, AI-credit checkout, checkout status, and portal routes.
 *
 * Extracted from ./billing-routes.ts (Phase 1-A4). Pure move: no logic changes.
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { appOrigin, resolveReturnPath } from './origins.js';
import { isSafeMarketingLandingPath } from './reddit-purchase-attribution.js';
import {
  abandonCreatingCheckoutAttempt,
  claimCardTrialCheckoutAttempt,
  claimCheckoutAttempt,
  finalizeCheckoutAttempt,
  getActiveCheckoutAttempt,
  getActiveUserMachineByClerkId,
  getBillingCustomerByClerkUserId,
  getBillingSubscription,
  getSettlingCheckoutAttempt,
  resolveCheckoutAttempt,
  type PlatformDB,
} from './db.js';
import {
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  resolveServerType,
  type MatrixBillingInterval,
  type MatrixBillingPlanSlug,
} from './billing.js';
import {
  DeveloperToolsWithDefaultSchema,
  defaultDeveloperToolsForServerType,
  developerToolsAllowedForServerType,
} from './developer-tools.js';
import { HetznerServerTypeSchema, RuntimeSlotSchema } from './customer-vps-schema.js';
import {
  AiCreditCheckoutRequestSchema,
  findAiCreditPackage,
} from './ai-credit-checkout.js';
import {
  AiCreditCheckoutStoreError,
  finalizeAiCreditCheckoutClaim,
  getClaimByRequestId,
  prepareAiCreditCheckoutClaim,
} from './ai-credit-checkout-store.js';
import { createRedditAttributionExpiry } from './reddit-purchase-attribution.js';
import {
  BILLING_BODY_LIMIT,
  BILLING_CHECKOUT_CREATED_EVENT,
  BILLING_CHECKOUT_FAILED_EVENT,
  BILLING_CHECKOUT_STARTED_EVENT,
  BILLING_UNAVAILABLE_RESPONSE,
  createPreparedCheckoutResponder,
  createRouteAuth,
  createTelemetryEmitter,
  HistoricalBillingRegionSlugSchema,
  MAX_STRIPE_API_TIMEOUT_MS,
  resolveBillingRouteContext,
  type BillingRouteOptions,
} from './billing-route-helpers.js';
const CheckoutBillingRegionSlugSchema = z.enum([
  'region_fsn1',
  'region_nbg1',
  'region_ash',
  'region_hil',
]);
const MarketingAttributionSchema = z.object({
  rdt_cid: z.string().min(1).max(256).optional(),
  utm_source: z.string().min(1).max(256).optional(),
  utm_medium: z.string().min(1).max(256).optional(),
  utm_campaign: z.string().min(1).max(256).optional(),
  utm_content: z.string().min(1).max(256).optional(),
  utm_term: z.string().min(1).max(256).optional(),
  landing_path: z.string().min(1).max(512).refine(
    (value) => isSafeMarketingLandingPath(value),
    { message: 'Invalid marketing landing path' },
  ).optional(),
}).strict();
export type MarketingAttribution = z.infer<typeof MarketingAttributionSchema>;

const CheckoutRequestSchema = z.object({
  planSlug: z.enum(['matrix_starter', 'matrix_builder', 'matrix_max']),
  interval: z.literal('monthly').default('monthly'),
  regionSlug: CheckoutBillingRegionSlugSchema.default('region_fsn1'),
  serverType: HetznerServerTypeSchema.optional(),
  developerTools: DeveloperToolsWithDefaultSchema,
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
  attribution: MarketingAttributionSchema.optional(),
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

const CheckoutPreparationStatusQuerySchema = z.object({
  attemptId: z.uuid(),
}).strict();


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
    selected_catalog_price_usd: planPriceUsd(data.planSlug, data.interval),
    utm_source: data.attribution?.utm_source,
    utm_medium: data.attribution?.utm_medium,
    utm_campaign: data.attribution?.utm_campaign,
    utm_content: data.attribution?.utm_content,
    utm_term: data.attribution?.utm_term,
    reddit_click_present: Boolean(data.attribution?.rdt_cid),
  };
}


function planPriceUsd(planSlug: MatrixBillingPlanSlug, interval: MatrixBillingInterval): number | undefined {
  const plan = DEFAULT_BILLING_PLAN_DEFINITIONS.find((candidate) => candidate.slug === planSlug);
  if (!plan) return undefined;
  return interval === 'monthly' ? plan.monthlyUsd : undefined;
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


export function createBillingCheckoutRoutes(options: BillingRouteOptions): Hono {
  const app = new Hono();
  const { env, now, cardTrialDays, primaryPrebillingRequired, persistEntitlement, aiCreditCheckout } =
    resolveBillingRouteContext(options);
  const emitTelemetry = createTelemetryEmitter(options.captureEvent);
  const resolveRouteClerkUserId = createRouteAuth(options.resolveClerkUserId);
  const preparedCheckoutResponse = createPreparedCheckoutResponder({
    prebilling: options.prebilling,
    primaryPrebillingRequired,
  });

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

  app.post('/ai-credit/checkout', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), async (c) => {
    const clerkUserId = await resolveRouteClerkUserId(c, 'ai-credit checkout');
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    if (!options.fundedAiRepository) {
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
      throw err;
    }
    const parsed = AiCreditCheckoutRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error('stripe_timeout_exceeds_budget');
      }
      const machine = await getActiveUserMachineByClerkId(options.db, clerkUserId, parsed.data.runtimeSlot);
      if (!machine || machine.status !== 'running' || machine.activationState !== 'authorized') {
        return c.json({ error: 'Computer is unavailable', code: 'runtime_unavailable' }, 409);
      }
      const idempotencyKey = `matrix-ai-credit:${createHash('sha256')
        .update(`${clerkUserId}\0${machine.machineId}\0${parsed.data.requestId}`)
        .digest('hex')}`;
      const persisted = await getClaimByRequestId(options.db, parsed.data.requestId);
      if (persisted && (persisted.owner_id !== clerkUserId || persisted.machine_id !== machine.machineId
        || persisted.runtime_slot !== machine.runtimeSlot || persisted.package_id !== parsed.data.packageId
        || persisted.idempotency_key !== idempotencyKey)) {
        throw new AiCreditCheckoutStoreError('conflict');
      }
      const selectedPackage = findAiCreditPackage(aiCreditCheckout, parsed.data.packageId);
      if (!persisted && !selectedPackage) return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
      const claim = persisted ?? await prepareAiCreditCheckoutClaim(options.db, {
        idempotencyKey, requestId: parsed.data.requestId, ownerId: clerkUserId,
        machineId: machine.machineId, runtimeSlot: machine.runtimeSlot,
        packageId: selectedPackage!.id, priceId: selectedPackage!.priceId,
        amountMicrousd: selectedPackage!.amountMicrousd, amountCents: selectedPackage!.amountCents,
        currency: selectedPackage!.currency, automaticTax: aiCreditCheckout.enabled && aiCreditCheckout.automaticTax,
      }, now());
      if (claim.checkout_url) return c.json({ url: claim.checkout_url }, 200);
      const session = await options.stripe.createAiCreditCheckoutSession({
        idempotencyKey: claim.idempotency_key,
        requestId: claim.request_id,
        clerkUserId: claim.owner_id,
        machineId: claim.machine_id,
        runtimeSlot: claim.runtime_slot,
        packageId: claim.package_id,
        priceId: claim.stripe_price_id,
        amountMicrousd: Number(claim.amount_microusd),
        automaticTax: claim.automatic_tax,
        successUrl: resolveBillingReturnUrl(env, 'success'),
        cancelUrl: resolveBillingReturnUrl(env, 'canceled'),
      });
      const finalized = await finalizeAiCreditCheckoutClaim(
        options.db, claim.request_id, session, now().toISOString(),
      );
      return c.json({ url: finalized.checkout_url }, 200);
    } catch (err: unknown) {
      if (err instanceof AiCreditCheckoutStoreError) {
        if (err.code === 'rate_limited') return c.json({ error: 'Too many requests' }, 429);
        if (err.code === 'conflict') return c.json({ error: 'Checkout already active' }, 409);
      }
      console.error('[billing] AI credit checkout failed:', err instanceof Error ? err.name : typeof err);
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }
  });

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
  return app;
}
