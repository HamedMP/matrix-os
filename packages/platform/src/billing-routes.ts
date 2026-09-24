import { Hono, type Context } from 'hono';
import { createBillingStatusHandler } from './billing-status-route.js';
import { bodyLimit } from 'hono/body-limit';
import { createHash, randomUUID } from 'node:crypto';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import {
  MATRIX_HOSTED_BILLING_REGIONS,
  type MatrixBillingPublicEntitlement,
  type MatrixHostedBillingRegionSlug,
} from '@matrix-os/contracts';
import { z } from 'zod/v4';
import { appOrigin, resolveReturnPath } from './origins.js';
import {
  abandonCreatingCheckoutAttempt,
  claimCardTrialCheckoutAttempt,
  claimCheckoutAttempt,
  cancelOutstandingBillingRuntimeActions,
  enqueueBillingRuntimeAction,
  finalizeCheckoutAttempt,
  getBillingCustomerByClerkUserId,
  getBillingCustomerByStripeCustomerId,
  consumeCardTrial,
  getBillingEntitlement,
  getBillingSubscription,
  getBillingSubscriptionByStripeId,
  getActiveUserMachineByClerkId,
  getActiveCheckoutAttempt,
  getSettlingCheckoutAttempt,
  insertBillingWebhookEvent,
  isCardTrialOfferEligible,
  projectTrialInvoiceEvent,
  resolveCheckoutAttempt,
  runBillingWebhookTransaction,
  listCurrentBillingSubscriptions,
  persistBillingSubscriptionPriceSnapshot,
  upsertBillingCustomer,
  upsertBillingEntitlement,
  upsertBillingSubscription,
  type PlatformDB,
  type BillingSubscriptionRecord,
  type UserMachineRecord,
} from './db.js';
import {
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  parseBillingEntitlementRecord,
  resolveServerType,
  type BillingEntitlementStatus,
  type BillingEntitlement,
  type MatrixBillingPlanSlug,
  type MatrixBillingInterval,
  type StripePriceCatalog,
  type StripeSubscriptionProjection,
} from './billing.js';
import {
  DeveloperToolsWithDefaultSchema,
  defaultDeveloperToolsForServerType,
  developerToolsAllowedForServerType,
  type DeveloperToolId,
} from './developer-tools.js';
import { HetznerServerTypeSchema, RuntimeSlotSchema } from './customer-vps-schema.js';
import {
  AiCreditCheckoutRequestSchema,
  findAiCreditPackage,
  loadAiCreditCheckoutConfig,
} from './ai-credit-checkout.js';
import {
  AiCreditCheckoutStoreError,
  finalizeAiCreditCheckoutClaim,
  getClaimByRequestId,
  prepareAiCreditCheckoutClaim,
} from './ai-credit-checkout-store.js';
import { processAiCreditWebhookEvent } from './ai-credit-checkout-webhook.js';
import { isAiCreditCheckoutRouteHealthy } from './ai-credit-checkout-readiness.js';
import type { RedditConversionsClient } from './reddit-conversions.js';
import {
  createRedditAttributionExpiry,
  deliverRedditAttribution,
  isSafeMarketingLandingPath,
} from './reddit-purchase-attribution.js';

import {
  MAX_STRIPE_API_TIMEOUT_MS,
  type StripeBillingClient,
  type StripeWebhookEvent,
} from './billing/stripe-client.js';
import {
  CheckoutBillingRegionSlugSchema,
  CheckoutPreparationStatusQuerySchema,
  CheckoutRequestSchema,
  CLERK_USER_ID_PATTERN,
  HistoricalBillingRegionSlugSchema,
  MarketingAttributionSchema,
  MATRIX_CARD_TRIAL_DAYS,
  PortalRequestSchema,
  type CheckoutRequest,
} from './billing/checkout-schemas.js';
import {
  buildCheckoutTelemetryProperties,
  buildSubscriptionTelemetryProperties,
  planPriceUsd,
  resolveBillingReturnUrl,
  resolveCardTrialDays,
  resolvePriceId,
  resolvePublicRecurringPrice,
  resolveRuntimePlacement,
  storedRecurringPrice,
} from './billing/checkout-support.js';
import {
  epochSecondsToIso,
  isFirstPostTrialInvoice,
  isSubscriptionEvent,
  normalizeSubscriptionStatus,
  projectSubscription,
  readClerkUserIdFromCheckoutSession,
  readClerkUserIdFromStripeMetadata,
  readExpandableStripeId,
  readInvoiceProjection,
  readPrebillingIntentIdFromStripeMetadata,
  readRegionSlugFromStripeMetadata,
  readRuntimeSlotFromStripeMetadata,
  readStripeObjectId,
  recomputeStripeSummary,
} from './billing/stripe-webhook-projection.js';

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
const BILLING_CHECKOUT_COMPLETED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_COMPLETED ?? 'matrix_billing_checkout_completed';
const BILLING_CHECKOUT_EXPIRED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_EXPIRED ?? 'matrix_billing_checkout_expired';
const BILLING_SUBSCRIPTION_UPDATED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_SUBSCRIPTION_UPDATED ?? 'matrix_billing_subscription_updated';
const BILLING_INVOICE_PAID_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_INVOICE_PAID ?? 'matrix_billing_invoice_paid';
const BILLING_INVOICE_PAYMENT_FAILED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_INVOICE_PAYMENT_FAILED ?? 'matrix_billing_invoice_payment_failed';
const BILLING_TRIAL_STARTED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_STARTED;
const BILLING_TRIAL_WILL_END_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_WILL_END;
const BILLING_TRIAL_CONVERTED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_CONVERTED;
const BILLING_TRIAL_PAYMENT_FAILED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_PAYMENT_FAILED;
const TRIAL_PAYMENT_SUSPEND_DELAY_MS = 24 * 60 * 60 * 1000;
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
    'grantCreditInTransaction' | 'getRuntimeFundingSummary'>;
  fundedRelayHealthFetch?: typeof fetch;
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
      if (!persisted && !await isAiCreditCheckoutRouteHealthy({
        repository: options.fundedAiRepository,
        identity: { ownerId: clerkUserId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot },
        relayBaseUrl: env.MATRIX_FUNDED_AI_RELAY_URL,
        fetchFn: options.fundedRelayHealthFetch,
        now,
      })) return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
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

    let preparationToResume: { intentId: string; clerkUserId: string } | undefined;
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

        const aiCreditResult = await processAiCreditWebhookEvent({
          event, trx, repository: options.fundedAiRepository, at: webhookProcessedAt.toISOString(),
        });
        if (aiCreditResult) return aiCreditResult;

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
              true,
            );
            if (event.type === 'checkout.session.expired') {
              const checkoutObject = event.data.object && typeof event.data.object === 'object'
                ? event.data.object as { metadata?: unknown }
                : undefined;
              const intentId = readPrebillingIntentIdFromStripeMetadata(checkoutObject?.metadata);
              const clerkUserId = readClerkUserIdFromCheckoutSession(event.data.object);
              await options.prebilling?.expireCheckout(trx, {
                stripeSessionId: sessionId,
                ...(intentId ? { intentId } : {}),
                ...(clerkUserId ? { clerkUserId } : {}),
                now: webhookProcessedAt.toISOString(),
              });
            }
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
          if (event.type !== 'invoice.paid' && event.type !== 'invoice.payment_failed') {
            return { received: true, ignored: true };
          }
          const invoice = readInvoiceProjection(event.data.object);
          if (!invoice) return { received: true, ignored: true };
          const subscription = await getBillingSubscriptionByStripeId(trx, invoice.stripeSubscriptionId);
          if (!subscription) return { received: true, ignored: true };
          emitTelemetry(
            event.type === 'invoice.paid'
              ? BILLING_INVOICE_PAID_EVENT
              : BILLING_INVOICE_PAYMENT_FAILED_EVENT,
            {
              distinctId: subscription.clerkUserId,
              properties: {
                amount_due_minor: invoice.amountDueMinor,
                amount_paid_minor: invoice.amountPaidMinor,
                currency: invoice.currency,
                plan_slug: subscription.planSlug,
                runtime_slot: subscription.runtimeSlot,
              },
            },
          );
          if (!isFirstPostTrialInvoice(invoice, subscription.trialEndsAt, subscription.trialConvertedAt)) {
            return { received: true, ignored: true };
          }
          const paymentIsRecoveringFailedTrial = Boolean(subscription.firstTrialPaymentFailedAt);
          const eventAt = epochSecondsToIso(event.created);
          const invoiceProjection = await projectTrialInvoiceEvent(trx, {
            stripeSubscriptionId: invoice.stripeSubscriptionId,
            type: event.type,
            eventCreatedAt: eventAt,
            eventId: event.id,
            lifecycleAt: eventAt,
            updatedAt: webhookProcessedAt.toISOString(),
          });
          if (!invoiceProjection?.applied) return { received: true, ignored: true };
          if (!invoiceProjection.lifecycleChanged) return { received: true, processed: true };
          const updated = invoiceProjection.subscription;
          if (event.type === 'invoice.payment_failed') {
            const canceledResumes = await cancelOutstandingBillingRuntimeActions(
              trx,
              updated.stripeSubscriptionId,
              'resume',
              webhookProcessedAt.toISOString(),
            );
            await enqueueBillingRuntimeAction(trx, {
              clerkUserId: updated.clerkUserId,
              runtimeSlot: updated.runtimeSlot,
              stripeSubscriptionId: updated.stripeSubscriptionId,
              action: 'suspend',
              reason: 'trial_payment_failed',
              executeAfter: canceledResumes.running > 0
                ? webhookProcessedAt.toISOString()
                : new Date(Date.parse(eventAt) + TRIAL_PAYMENT_SUSPEND_DELAY_MS).toISOString(),
              createdAt: webhookProcessedAt.toISOString(),
            });
            emitTelemetry(BILLING_TRIAL_PAYMENT_FAILED_EVENT, {
              distinctId: updated.clerkUserId,
              properties: { billing_interval: updated.billingInterval ?? undefined },
            });
          } else {
            const canceledSuspensions = await cancelOutstandingBillingRuntimeActions(
              trx,
              updated.stripeSubscriptionId,
              'suspend',
              webhookProcessedAt.toISOString(),
            );
            const machine = paymentIsRecoveringFailedTrial
              ? await getActiveUserMachineByClerkId(trx, updated.clerkUserId, updated.runtimeSlot)
              : undefined;
            const recoveryRequiresResume = paymentIsRecoveringFailedTrial && (
              canceledSuspensions.running > 0
              || machine?.status === 'suspended'
              || machine?.status === 'suspending'
            );
            if (recoveryRequiresResume) {
              await enqueueBillingRuntimeAction(trx, {
                clerkUserId: updated.clerkUserId,
                runtimeSlot: updated.runtimeSlot,
                stripeSubscriptionId: updated.stripeSubscriptionId,
                action: 'resume',
                reason: 'payment_recovered',
                executeAfter: webhookProcessedAt.toISOString(),
                createdAt: webhookProcessedAt.toISOString(),
              });
            }
            emitTelemetry(BILLING_TRIAL_CONVERTED_EVENT, {
              distinctId: updated.clerkUserId,
              properties: { billing_interval: updated.billingInterval ?? undefined },
            });
          }
          const priceCatalog = loadStripePriceCatalog(env);
          const summary = await recomputeStripeSummary(trx, updated.clerkUserId, priceCatalog, env, webhookProcessedAt);
          if (summary) await persistEntitlement(trx, summary);
          return { received: true, processed: true };
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
        const recurringItem = projection.items.find(
          (item) => item.priceId === entitlement.stripePriceId,
        );
        const projectionApplied = await upsertBillingSubscription(trx, {
          stripeSubscriptionId: projection.stripeSubscriptionId,
          stripeCustomerId: projection.stripeCustomerId,
          clerkUserId: projection.clerkUserId,
          runtimeSlot: projection.runtimeSlot,
          planSlug: priceEntry.planSlug,
          stripePriceId: entitlement.stripePriceId,
          billingInterval: recurringItem?.interval ?? priceEntry.interval,
          priceUnitAmountMinor: recurringItem?.unitAmountMinor ?? null,
          priceCurrency: recurringItem?.currency ?? null,
          priceIntervalCount: recurringItem?.intervalCount ?? null,
          priceQuantity: recurringItem?.quantity ?? 1,
          status: entitlement.status,
          currentPeriodEnd: projection.currentPeriodEnd ?? null,
          gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
          trialStartedAt: projection.trialStartedAt ?? null,
          trialEndsAt: projection.trialEndsAt ?? null,
          trialConvertedAt: projection.trialConvertedAt ?? null,
          firstTrialPaymentFailedAt: projection.firstTrialPaymentFailedAt ?? null,
          latestEventCreatedAt: epochSecondsToIso(event.created),
          latestEventId: event.id,
          updatedAt: webhookProcessedAt.toISOString(),
        });
        if (!projectionApplied) return { received: true, processed: true };
        if (projection.status === 'trialing' && !projection.firstTrialPaymentFailedAt) {
          const canceledSuspensions = await cancelOutstandingBillingRuntimeActions(
            trx,
            projection.stripeSubscriptionId,
            'suspend',
            webhookProcessedAt.toISOString(),
          );
          const machine = await getActiveUserMachineByClerkId(
            trx,
            projection.clerkUserId,
            projection.runtimeSlot,
          );
          if (
            canceledSuspensions.running > 0
            || machine?.status === 'suspended'
            || machine?.status === 'suspending'
          ) {
            await enqueueBillingRuntimeAction(trx, {
              clerkUserId: projection.clerkUserId,
              runtimeSlot: projection.runtimeSlot,
              stripeSubscriptionId: projection.stripeSubscriptionId,
              action: 'resume',
              reason: 'billing_recovered',
              executeAfter: webhookProcessedAt.toISOString(),
              createdAt: webhookProcessedAt.toISOString(),
            });
          }
        }
        const summary = await recomputeStripeSummary(trx, projection.clerkUserId, priceCatalog, env, webhookProcessedAt);
        if (summary) await persistEntitlement(trx, summary);
        if (
          summary
          && projection.prebillingIntentId
          && getRuntimeAccessDecision(summary, webhookProcessedAt).runtimeProxyAllowed
        ) {
          if (!options.prebilling) throw new Error('prebilling_authorization_unavailable');
          const authorization = await options.prebilling.authorizeSubscription(trx, {
            intentId: projection.prebillingIntentId,
            clerkUserId: projection.clerkUserId,
            runtimeSlot: projection.runtimeSlot,
            now: webhookProcessedAt.toISOString(),
          });
          if (!authorization.authorized) {
            preparationToResume = {
              intentId: projection.prebillingIntentId,
              clerkUserId: projection.clerkUserId,
            };
          }
        }
        const telemetryMachine = await getActiveUserMachineByClerkId(
          trx,
          projection.clerkUserId,
          projection.runtimeSlot,
        );
        emitTelemetry(BILLING_SUBSCRIPTION_UPDATED_EVENT, {
          distinctId: entitlement.clerkUserId,
          properties: buildSubscriptionTelemetryProperties({
            entitlement,
            recurringItem,
            runtimeSlot: projection.runtimeSlot,
            regionSlug: projection.regionSlug,
            machine: telemetryMachine,
          }),
        });
        if (event.type === 'customer.subscription.created' && projection.status === 'trialing') {
          await consumeCardTrial(trx, projection.clerkUserId, webhookProcessedAt.toISOString());
          emitTelemetry(BILLING_TRIAL_STARTED_EVENT, { distinctId: projection.clerkUserId });
        }
        if (event.type === 'customer.subscription.trial_will_end') {
          emitTelemetry(BILLING_TRIAL_WILL_END_EVENT, { distinctId: projection.clerkUserId });
        }
        if (
          projection.trialEndsAt
          && !projection.trialConvertedAt
          && (projection.status === 'canceled' || projection.status === 'unpaid' || projection.status === 'ended')
        ) {
          const canceledResumes = await cancelOutstandingBillingRuntimeActions(
            trx,
            projection.stripeSubscriptionId,
            'resume',
            webhookProcessedAt.toISOString(),
          );
          await enqueueBillingRuntimeAction(trx, {
            clerkUserId: projection.clerkUserId,
            runtimeSlot: projection.runtimeSlot,
            stripeSubscriptionId: projection.stripeSubscriptionId,
            action: 'suspend',
            reason: 'trial_ended_unpaid',
            executeAfter: canceledResumes.running > 0
              ? webhookProcessedAt.toISOString()
              : new Date(
                Date.parse(projection.trialEndsAt) + TRIAL_PAYMENT_SUSPEND_DELAY_MS,
              ).toISOString(),
            createdAt: webhookProcessedAt.toISOString(),
          });
        }
        return { received: true, processed: true };
      });
      if (preparationToResume && options.prebilling) {
        void options.prebilling.resumePreparation(preparationToResume).catch((err: unknown) => {
          console.error(
            `[billing] paid preparation kick failed intent=${preparationToResume?.intentId ?? 'unknown'}`,
            err instanceof Error ? err.name : typeof err,
          );
        });
      }
      const clearSubscriptionAttribution = options.stripe.clearSubscriptionAttribution?.bind(options.stripe);
      await deliverRedditAttribution(
        event,
        options.redditConversions,
        clearSubscriptionAttribution ? { clearSubscriptionAttribution } : undefined,
      );
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

export function getPublicBillingPlans() {
  return DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => ({
    slug: plan.slug,
    marketingName: plan.marketingName,
    monthlyUsd: plan.monthlyUsd,
    includedRuntimeSlots: plan.includedRuntimeSlots,
  }));
}
