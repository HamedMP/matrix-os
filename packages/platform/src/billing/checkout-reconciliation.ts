import type { Context, Handler } from 'hono';
import {
  finalizeCheckoutAttempt,
  getActiveCheckoutAttempt,
  getBillingCustomerByClerkUserId,
  resolveCheckoutAttempt,
  type BillingCheckoutAttemptRecord,
  type PlatformDB,
} from '../db.js';
import { createBoundedRateLimiter } from '../request-admission.js';
import type { PrebillingCheckoutCoordinator } from '../billing-routes.js';
import { CheckoutAbandonRequestSchema, CheckoutRequestSchema } from './checkout-schemas.js';
import { rememberGoogleAttribution } from './google-attribution-store.js';
import { resolveBillingReturnUrl, resolvePriceId } from './checkout-support.js';
import { createRedditAttributionExpiry } from '../reddit-purchase-attribution.js';
import { MAX_STRIPE_API_TIMEOUT_MS, type StripeBillingClient } from './stripe-client.js';

const UNAVAILABLE = { error: 'Billing unavailable', code: 'billing_unavailable' } as const;

export interface CheckoutAttemptRecoveryOptions {
  db: PlatformDB;
  stripe: StripeBillingClient;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  prebilling?: Pick<PrebillingCheckoutCoordinator, 'createIntent' | 'startPreparation' | 'expireCheckout'>;
}

export async function createStoredCheckoutSession(
  options: CheckoutAttemptRecoveryOptions,
  attempt: BillingCheckoutAttemptRecord,
): Promise<Awaited<ReturnType<StripeBillingClient['createCheckoutSession']>> | null> {
  if (!attempt.requestPayload) return null;
  const parsed = CheckoutRequestSchema.safeParse(JSON.parse(attempt.requestPayload) as unknown);
  if (!parsed.success) throw new Error('checkout_request_snapshot_invalid');
  const request = parsed.data;
  if (
    request.runtimeSlot !== attempt.runtimeSlot
    || request.planSlug !== attempt.planSlug
    || request.interval !== attempt.billingInterval
    || request.regionSlug !== attempt.regionSlug
    || JSON.stringify(request.developerTools) !== JSON.stringify(attempt.developerTools)
  ) {
    throw new Error('checkout_request_snapshot_mismatch');
  }
  const priceId = resolvePriceId(options.env, request.planSlug, request.interval);
  if (!priceId) throw new Error('checkout_price_config_missing');
  const currentTime = options.now();
  const customer = await getBillingCustomerByClerkUserId(options.db, attempt.clerkUserId);
  let preparation: { intentId: string; expiresAt: string } | undefined;
  if (options.prebilling && attempt.serverType && request.runtimeSlot === 'primary') {
    preparation = await options.prebilling.createIntent({
      checkoutAttemptId: attempt.id,
      clerkUserId: attempt.clerkUserId,
      runtimeSlot: 'primary',
      planSlug: request.planSlug,
      billingInterval: request.interval,
      serverType: attempt.serverType,
      regionSlug: request.regionSlug,
      developerTools: request.developerTools,
      now: currentTime.toISOString(),
    });
  }
  if (options.prebilling && request.runtimeSlot === 'primary' && !preparation) return null;
  const googleAnalytics = await rememberGoogleAttribution(
    options.db,
    attempt.id,
    attempt.clerkUserId,
    request.googleAnalytics,
    currentTime.toISOString(),
  );
  const session = await options.stripe.createCheckoutSession({
    idempotencyKey: attempt.id,
    clerkUserId: attempt.clerkUserId,
    customerId: customer?.stripeCustomerId,
    priceId,
    mode: 'subscription',
    automaticTax: true,
    allowPromotionCodes: true,
    regionSlug: request.regionSlug,
    runtimeSlot: request.runtimeSlot,
    redditAttributionExpiresAt: createRedditAttributionExpiry(
      attempt.createdAt,
      attempt.trialPeriodDays,
    ),
    trialPeriodDays: attempt.trialPeriodDays,
    paymentMethodMode: attempt.trialPeriodDays ? 'card_required' : 'dynamic',
    ...(preparation ? {
      prebillingIntentId: preparation.intentId,
      expiresAt: preparation.expiresAt,
    } : {}),
    attribution: request.attribution,
    googleAnalytics,
    planSlug: request.planSlug,
    interval: request.interval,
    successUrl: resolveBillingReturnUrl(options.env, 'success', request.returnPath),
    cancelUrl: resolveBillingReturnUrl(options.env, 'canceled', request.returnPath),
  });
  if (!await finalizeCheckoutAttempt(options.db, attempt.id, session.id, session.url)) return null;
  if (preparation) {
    try {
      const started = await options.prebilling?.startPreparation({
        intentId: preparation.intentId,
        stripeSessionId: session.id,
        stripeSessionExpiresAt: session.expiresAt ?? preparation.expiresAt,
      });
      if (!started) console.warn('[billing] prebilling preparation deferred');
    } catch (err: unknown) {
      console.warn('[billing] recovered prebilling preparation unavailable:', err instanceof Error ? err.name : typeof err);
    }
  }
  return session;
}

interface CheckoutReconciliationOptions extends CheckoutAttemptRecoveryOptions {
  resolveClerkUserId: (c: Context) => Promise<string | null>;
}

/** Reconcile only the authenticated owner's stored attempt; never grant access. */
export function createCheckoutReconciliationHandler(options: CheckoutReconciliationOptions): Handler {
  const limiter = createBoundedRateLimiter(12);
  return async c => {
    c.header('Cache-Control', 'no-store');
    const clerkUserId = await options.resolveClerkUserId(c);
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
      // Preserve bodyLimit's streaming error so its middleware emits 413.
      throw error;
    }
    const parsed = CheckoutAbandonRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const attempt = await getActiveCheckoutAttempt(options.db, clerkUserId, parsed.data.runtimeSlot);
      if (!attempt) return c.json({ status: 'none' }, 200);
      if (!limiter.check(clerkUserId)) return c.json(UNAVAILABLE, 429);
      if (attempt.status === 'creating' && attempt.requestPayload) {
        const recovered = await createStoredCheckoutSession(options, attempt);
        if (recovered) return c.json({ status: 'open' }, 200);
      }
      if (attempt.status !== 'open' || !attempt.stripeSessionId) {
        // An ambiguous create may already have a provider session. Never route
        // back to a fresh purchase until the original create has reconciled.
        return c.json(UNAVAILABLE, 503);
      }
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) throw new Error('stripe_timeout_exceeds_budget');
      const sessionId = attempt.stripeSessionId;
      const session = await options.stripe.retrieveCheckoutSession(sessionId);
      if (session.clerkUserId !== clerkUserId) throw new Error('checkout_session_owner_mismatch');
      if (session.status === 'complete') {
        await resolveCheckoutAttempt(options.db, sessionId, 'paid', options.now().toISOString());
      } else if (session.status === 'expired') {
        const resolvedAt = options.now().toISOString();
        await options.db.transaction(async trx => {
          const resolved = await resolveCheckoutAttempt(trx, sessionId, 'expired', resolvedAt, true);
          if (resolved) await options.prebilling?.expireCheckout(trx, {
            stripeSessionId: sessionId, clerkUserId, now: resolvedAt,
          });
        });
      } else if (session.status !== 'open') {
        throw new Error('checkout_session_status_invalid');
      }
      // This observation never grants access; the journey reads authoritative
      // local state next, including any webhook that won the conditional write.
      return c.json({ status: session.status }, 200);
    } catch (error: unknown) {
      console.error('[billing] checkout reconciliation failed:', error);
      return c.json(UNAVAILABLE, 503);
    }
  };
}
