/**
 * Billing route composition facade (Phase 1-A4).
 *
 * Checkout/portal routes live in ./billing-checkout-routes.ts, the Stripe
 * webhook in ./billing-stripe-webhook.ts, shared context in
 * ./billing-route-helpers.ts. This module only mounts them.
 */
import { Hono, type Context } from 'hono';
import { createBillingStatusHandler } from './billing-status-route.js';
import type {
  MatrixBillingPublicEntitlement,
  MatrixHostedBillingRegionSlug,
} from '@matrix-os/contracts';
import { MATRIX_HOSTED_BILLING_REGIONS } from '@matrix-os/contracts';
import { persistBillingSubscriptionPriceSnapshot, type BillingSubscriptionRecord, type PlatformDB } from './db.js';
import { bodyLimit } from 'hono/body-limit';
import { createBillingCheckoutRoutes } from './billing-checkout-routes.js';
import { createBillingStripeWebhookRoutes } from './billing-stripe-webhook.js';
import {
  BILLING_BODY_LIMIT,
  MAX_STRIPE_API_TIMEOUT_MS,
  type StripeBillingClient,
  createRouteAuth,
  resolveBillingRouteContext,
  resolveRuntimePlacement,
  type BillingRouteOptions,
} from './billing-route-helpers.js';
export type {
  BillingRouteOptions,
  PrebillingCheckoutCoordinator,
  StripeAiCreditCheckoutSessionInput,
  StripeBillingClient,
  StripeCheckoutSessionInput,
  StripeCheckoutSessionProjection,
  StripeRecurringPriceProjection,
  StripeWebhookEvent,
} from './billing-route-helpers.js';
export { MATRIX_CARD_TRIAL_DAYS } from './billing-route-helpers.js';
export type { MarketingAttribution } from './billing-checkout-routes.js';
export { getPublicBillingPlans } from './billing-stripe-webhook.js';

function storedRecurringPrice(
  subscription: BillingSubscriptionRecord,
): MatrixBillingPublicEntitlement['recurringPrice'] {
  if (
    subscription.priceUnitAmountMinor === null
    || !Number.isSafeInteger(subscription.priceUnitAmountMinor)
    || subscription.priceUnitAmountMinor < 0
    || subscription.priceCurrency === null
    || !/^[a-z]{3}$/.test(subscription.priceCurrency)
    || subscription.billingInterval === null
    || subscription.priceIntervalCount === null
    || !Number.isSafeInteger(subscription.priceIntervalCount)
    || subscription.priceIntervalCount < 1
    || subscription.priceQuantity === null
    || !Number.isSafeInteger(subscription.priceQuantity)
    || subscription.priceQuantity < 1
  ) {
    return null;
  }
  return {
    unitAmountMinor: subscription.priceUnitAmountMinor,
    currency: subscription.priceCurrency,
    interval: subscription.billingInterval,
    intervalCount: subscription.priceIntervalCount,
    quantity: subscription.priceQuantity,
  };
}

async function resolvePublicRecurringPrice(
  db: PlatformDB,
  stripe: StripeBillingClient,
  subscription: BillingSubscriptionRecord,
  currentTime: Date,
): Promise<MatrixBillingPublicEntitlement['recurringPrice']> {
  const stored = storedRecurringPrice(subscription);
  if (stored) return stored;
  if (stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) return null;

  try {
    const price = await stripe.retrieveRecurringPrice(subscription.stripePriceId);
    if (price.priceId !== subscription.stripePriceId) return null;
    const quantity = subscription.priceQuantity ?? 1;
    const persisted = await persistBillingSubscriptionPriceSnapshot(db, {
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      expectedStripePriceId: subscription.stripePriceId,
      unitAmountMinor: price.unitAmountMinor,
      currency: price.currency,
      interval: price.interval,
      intervalCount: price.intervalCount,
      quantity,
      updatedAt: currentTime.toISOString(),
    });
    if (!persisted) return null;
    return {
      unitAmountMinor: price.unitAmountMinor,
      currency: price.currency,
      interval: price.interval,
      intervalCount: price.intervalCount,
      quantity,
    };
  } catch (err: unknown) {
    console.warn(
      '[billing] recurring price snapshot unavailable:',
      err instanceof Error ? err.name : typeof err,
    );
    return null;
  }
}


export function createBillingRoutes(options: BillingRouteOptions): Hono {
  const app = new Hono();
  const { env, now, cardTrialDays } = resolveBillingRouteContext(options);
  const resolveRouteClerkUserId = createRouteAuth(options.resolveClerkUserId);

  app.route('/', createBillingCheckoutRoutes(options));
  app.route('/', createBillingStripeWebhookRoutes(options));

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

  app.all('*', bodyLimit({ maxSize: BILLING_BODY_LIMIT }), (c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  return app;
}