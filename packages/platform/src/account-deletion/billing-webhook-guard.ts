import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { getBillingCustomerByStripeCustomerId, getBillingSubscriptionByStripeId, type PlatformDB } from '../db.js';
import type { StripeBillingClient, StripeWebhookEvent } from '../billing/stripe-client.js';
import { readClerkUserIdFromStripeMetadata, readExpandableStripeId } from '../billing/stripe-webhook-projection.js';
import { CLERK_USER_ID_PATTERN } from '../billing/checkout-schemas.js';
import { getAccountDeletionAdmission } from './admission.js';
import { projectAccountDeletionBillingCancellation } from './billing-projection.js';

const CustomerId = z.string().regex(/^cus_[A-Za-z0-9_]{1,200}$/);
const SubscriptionId = z.string().regex(/^sub_[A-Za-z0-9_]{1,200}$/);
const ObjectProjection = z.object({
  id: z.string().max(255), customer: z.unknown(), metadata: z.unknown().optional(),
  subscription: z.unknown().optional(), client_reference_id: z.unknown().optional(),
}).passthrough();
const LiveSubscription = z.object({ id: SubscriptionId, customer: z.unknown(), status: z.string().min(1).max(64) });
const SUBSCRIPTION_EVENTS = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end'];
const CHECKOUT_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
const TERMINAL = ['canceled', 'incomplete_expired'];
const ACTIVE = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

async function resolveSubscriptionOwner(db: PlatformDB, event: StripeWebhookEvent): Promise<{
  owner: string; subscriptionId: string; customerId: string;
} | null> {
  const subscriptionEvent = SUBSCRIPTION_EVENTS.includes(event.type);
  if (!subscriptionEvent && !CHECKOUT_EVENTS.includes(event.type)) return null;
  const parsed = ObjectProjection.safeParse(event.data.object);
  if (!parsed.success) throw new Error('Invalid billing identity');
  const object = parsed.data;
  const subscriptionId = subscriptionEvent ? SubscriptionId.parse(object.id)
    : SubscriptionId.nullable().parse(readExpandableStripeId(object.subscription));
  if (subscriptionId === null) return null;
  const customerId = CustomerId.parse(readExpandableStripeId(object.customer));
  const metadataOwner = readClerkUserIdFromStripeMetadata(object.metadata);
  const checkoutOwner = !subscriptionEvent && typeof object.client_reference_id === 'string'
    && CLERK_USER_ID_PATTERN.test(object.client_reference_id) ? object.client_reference_id : null;
  if (metadataOwner && checkoutOwner && metadataOwner !== checkoutOwner) throw new Error('Ambiguous billing identity');
  const customer = await getBillingCustomerByStripeCustomerId(db, customerId);
  const subscription = await getBillingSubscriptionByStripeId(db, subscriptionId);
  if (subscription && subscription.stripeCustomerId !== customerId) throw new Error('Ambiguous billing customer');
  const owners = [metadataOwner, checkoutOwner, customer?.clerkUserId, subscription?.clerkUserId].filter((owner): owner is string => Boolean(owner));
  if (owners.some((owner) => owner !== owners[0])) throw new Error('Ambiguous billing owner');
  return owners[0] ? { owner: owners[0], subscriptionId, customerId } : null;
}

async function cancelVerifiedSubscription(input: {
  subscriptionId: string; customerId: string; key: string; request: typeof fetch;
}): Promise<void> {
  const url = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`;
  const init = (method: 'GET' | 'DELETE'): RequestInit => ({
    method, redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${input.key}`, 'content-type': 'application/x-www-form-urlencoded' },
    ...(method === 'DELETE' ? { body: new URLSearchParams({ invoice_now: 'false', prorate: 'false' }) } : {}),
  });
  const live = await input.request(url, init('GET'));
  if (live.status === 404) return;
  if (!live.ok) throw new Error('Billing cleanup failed');
  const subscription = LiveSubscription.parse(await live.json());
  if (subscription.id !== input.subscriptionId || readExpandableStripeId(subscription.customer) !== input.customerId) {
    throw new Error('Ambiguous live billing identity');
  }
  if (TERMINAL.includes(subscription.status)) return;
  if (!ACTIVE.includes(subscription.status)) throw new Error('Unknown billing state');
  const canceled = await input.request(url, init('DELETE'));
  if (canceled.status === 404) return;
  if (!canceled.ok) throw new Error('Billing cleanup failed');
  const result = LiveSubscription.parse(await canceled.json());
  if (result.id !== input.subscriptionId || readExpandableStripeId(result.customer) !== input.customerId || result.status !== 'canceled') {
    throw new Error('Billing cleanup not confirmed');
  }
}

/** Verify the signed provider event before any cancellation. Normal requests retain their original body stream. */
export function createAccountDeletionBillingWebhookGuard(options: {
  db: PlatformDB;
  stripe: Pick<StripeBillingClient, 'constructWebhookEvent'>;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}): MiddlewareHandler {
  const env = options.env ?? process.env;
  const limit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) });
  const guard: MiddlewareHandler = async (c, next) => {
    if(!env.ACCOUNT_DELETION_SECRET){await next();return;}
    const signature = c.req.header('stripe-signature');
    if (!signature || signature.length > 4096) return c.json({ error: 'Unauthorized' }, 401);
    if (!env.STRIPE_WEBHOOK_SECRET) return c.json({ error: 'Billing cleanup unavailable' }, 503);
    let raw: string;
    try { raw = await c.req.raw.clone().text(); }
    catch (error: unknown) {
      if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'Request too large' }, 413);
      console.error('[account-deletion] webhook read failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Billing cleanup unavailable' }, 503);
    }
    let event: StripeWebhookEvent;
    try { event = options.stripe.constructWebhookEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET); }
    catch (error: unknown) {
      console.warn('[account-deletion] webhook verification failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      const identity = await resolveSubscriptionOwner(options.db, event);
      const cleanupIfBlocked = async () => {
        if (!identity || (await getAccountDeletionAdmission(options.db, identity.owner, env)).newWorkAllowed) return false;
        if (!env.STRIPE_SECRET_KEY) throw new Error('Billing cleanup configuration unavailable');
        await cancelVerifiedSubscription({ ...identity, key: env.STRIPE_SECRET_KEY, request: options.request ?? fetch });
        await projectAccountDeletionBillingCancellation(options.db, { clerkUserId: identity.owner,
          stripeSubscriptionId: identity.subscriptionId, stripeCustomerId: identity.customerId }, env);
        return true;
      };
      if (await cleanupIfBlocked()) return c.json({ received: true, ignored: true }, 200);
      await next();
      // Acceptance may commit while normal projection is running. Recheck before
      // acknowledging so a missing customer projection cannot hide a new charge.
      if (await cleanupIfBlocked()) return c.json({ received: true, ignored: true }, 200);
    } catch (error: unknown) {
      console.error('[account-deletion] webhook cleanup failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Billing cleanup unavailable' }, 503);
    }
  };
  return async (c, next) => limit(c, async () => {
    const response = await guard(c, next);
    if (response) c.res = response;
  });
}
