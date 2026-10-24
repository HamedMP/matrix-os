import type { Context, Handler } from 'hono';
import { getActiveCheckoutAttempt, resolveCheckoutAttempt, type PlatformDB } from '../db.js';
import { createBoundedRateLimiter } from '../request-admission.js';
import type { PrebillingCheckoutCoordinator } from '../billing-routes.js';
import { CheckoutAbandonRequestSchema } from './checkout-schemas.js';
import { MAX_STRIPE_API_TIMEOUT_MS, type StripeBillingClient } from './stripe-client.js';

const UNAVAILABLE = { error: 'Billing unavailable', code: 'billing_unavailable' } as const;

/** Reconcile only the authenticated owner's stored session; never create payment or grant access. */
export function createCheckoutReconciliationHandler(options: {
  db: PlatformDB;
  stripe: StripeBillingClient;
  resolveClerkUserId: (c: Context) => Promise<string | null>;
  now: () => Date;
  prebilling?: Pick<PrebillingCheckoutCoordinator, 'expireCheckout'>;
}): Handler {
  const limiter = createBoundedRateLimiter(12);
  return async c => {
    c.header('Cache-Control', 'no-store');
    const clerkUserId = await options.resolveClerkUserId(c);
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    if (!limiter.check(clerkUserId)) return c.json(UNAVAILABLE, 429);
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
