import type { MatrixHostedBillingRegionSlug } from '@matrix-os/contracts';
import { z } from 'zod/v4';
import {
  getBillingCustomerByStripeCustomerId,
  getBillingSubscriptionByStripeId,
  listCurrentBillingSubscriptions,
  upsertBillingCustomer,
  type PlatformDB,
} from '../db.js';
import {
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  type BillingEntitlement,
  type BillingEntitlementStatus,
  type StripePriceCatalog,
  type StripeSubscriptionProjection,
} from '../billing.js';
import { RuntimeSlotSchema } from '../customer-vps-schema.js';
import { CLERK_USER_ID_PATTERN, HistoricalBillingRegionSlugSchema } from './checkout-schemas.js';

/** Extracted verbatim from packages/platform/src/billing-routes.ts (S01 / T007): Stripe subscription and invoice webhook projection. */

export function isSubscriptionEvent(type: string): boolean {
  return (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted' ||
    type === 'customer.subscription.trial_will_end'
  );
}

export async function projectSubscription(
  db: PlatformDB,
  value: unknown,
  currentTime: Date,
): Promise<(StripeSubscriptionProjection & {
  runtimeSlot: string;
  regionSlug: MatrixHostedBillingRegionSlug | null;
  prebillingIntentId: string | null;
}) | null> {
  if (!value || typeof value !== 'object') return null;
  const sub = value as {
    id?: unknown;
    customer?: unknown;
    status?: unknown;
    current_period_end?: unknown;
    trial_start?: unknown;
    trial_end?: unknown;
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
  const existing = await getBillingSubscriptionByStripeId(db, sub.id);
  const runtimeSlot = readRuntimeSlotFromStripeMetadata(sub.metadata) ?? 'primary';
  const data = Array.isArray(sub.items?.data) ? sub.items.data : [];
  const itemPeriodBoundaries = data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as {
      current_period_start?: unknown;
      current_period_end?: unknown;
    };
    const boundary = status === 'past_due' || status === 'unpaid'
      ? candidate.current_period_start
      : candidate.current_period_end;
    return typeof boundary === 'number' ? [boundary] : [];
  });
  const itemPeriodBoundary = itemPeriodBoundaries.length > 0
    ? Math.min(...itemPeriodBoundaries)
    : null;
  return {
    clerkUserId: customer.clerkUserId,
    stripeCustomerId: customer.stripeCustomerId,
    stripeSubscriptionId: sub.id,
    runtimeSlot,
    regionSlug: readRegionSlugFromStripeMetadata(sub.metadata),
    prebillingIntentId: readPrebillingIntentIdFromStripeMetadata(sub.metadata),
    status,
    currentPeriodEnd: typeof sub.current_period_end === 'number'
      ? epochSecondsToIso(sub.current_period_end)
      : (itemPeriodBoundary === null ? null : epochSecondsToIso(itemPeriodBoundary)),
    trialStartedAt: typeof sub.trial_start === 'number'
      ? epochSecondsToIso(sub.trial_start)
      : (existing?.trialStartedAt ?? null),
    trialEndsAt: typeof sub.trial_end === 'number'
      ? epochSecondsToIso(sub.trial_end)
      : (existing?.trialEndsAt ?? null),
    trialConvertedAt: existing?.trialConvertedAt ?? null,
    firstTrialPaymentFailedAt: existing?.firstTrialPaymentFailedAt ?? null,
    items: data.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as {
        price?: {
          id?: unknown;
          unit_amount?: unknown;
          currency?: unknown;
          recurring?: { interval?: unknown; interval_count?: unknown };
        };
        quantity?: unknown;
      };
      if (typeof candidate.price?.id !== 'string') return [];
      const interval = candidate.price.recurring?.interval === 'month'
        ? 'monthly'
        : candidate.price.recurring?.interval === 'year'
          ? 'annual'
          : null;
      return [{
        priceId: candidate.price.id,
        quantity: typeof candidate.quantity === 'number' && Number.isInteger(candidate.quantity) && candidate.quantity > 0
          ? candidate.quantity
          : 1,
        unitAmountMinor: typeof candidate.price.unit_amount === 'number'
          && Number.isInteger(candidate.price.unit_amount)
          && candidate.price.unit_amount >= 0
          ? candidate.price.unit_amount
          : null,
        currency: typeof candidate.price.currency === 'string' && /^[a-z]{3}$/.test(candidate.price.currency)
          ? candidate.price.currency
          : null,
        interval,
        intervalCount: typeof candidate.price.recurring?.interval_count === 'number'
          && Number.isInteger(candidate.price.recurring.interval_count)
          && candidate.price.recurring.interval_count > 0
          ? candidate.price.recurring.interval_count
          : null,
      }];
    }),
  };
}

export function readRuntimeSlotFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = RuntimeSlotSchema.safeParse((metadata as { matrix_runtime_slot?: unknown }).matrix_runtime_slot);
  return parsed.success ? parsed.data : null;
}

export function readRegionSlugFromStripeMetadata(metadata: unknown): MatrixHostedBillingRegionSlug | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = HistoricalBillingRegionSlugSchema.safeParse(
    (metadata as { matrix_region_slug?: unknown }).matrix_region_slug,
  );
  return parsed.success ? parsed.data : null;
}

export function readPrebillingIntentIdFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(
    (metadata as { matrix_prebilling_intent_id?: unknown }).matrix_prebilling_intent_id,
  );
  return parsed.success ? parsed.data : null;
}

export async function recomputeStripeSummary(
  db: PlatformDB,
  clerkUserId: string,
  priceCatalog: StripePriceCatalog,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<BillingEntitlement | null> {
  const subscriptions = await listCurrentBillingSubscriptions(db, clerkUserId, now.toISOString());
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
      trialStartedAt: subscription.trialStartedAt,
      trialEndsAt: subscription.trialEndsAt,
      trialConvertedAt: subscription.trialConvertedAt,
      firstTrialPaymentFailedAt: subscription.firstTrialPaymentFailedAt,
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

export interface StripeInvoiceProjection {
  stripeSubscriptionId: string;
  billingReason: string;
  createdAt: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
}

export function readInvoiceProjection(value: unknown): StripeInvoiceProjection | null {
  if (!value || typeof value !== 'object') return null;
  const invoice = value as {
    created?: unknown;
    billing_reason?: unknown;
    amount_due?: unknown;
    amount_paid?: unknown;
    currency?: unknown;
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } };
  };
  const subscription = readExpandableStripeId(
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription,
  );
  if (
    !subscription
    || typeof invoice.created !== 'number'
    || typeof invoice.billing_reason !== 'string'
    || typeof invoice.amount_due !== 'number'
    || !Number.isSafeInteger(invoice.amount_due)
    || invoice.amount_due < 0
    || typeof invoice.amount_paid !== 'number'
    || !Number.isSafeInteger(invoice.amount_paid)
    || invoice.amount_paid < 0
    || typeof invoice.currency !== 'string'
    || !/^[a-z]{3}$/.test(invoice.currency)
  ) {
    return null;
  }
  return {
    stripeSubscriptionId: subscription,
    billingReason: invoice.billing_reason,
    createdAt: epochSecondsToIso(invoice.created),
    amountDueMinor: invoice.amount_due,
    amountPaidMinor: invoice.amount_paid,
    currency: invoice.currency,
  };
}

export function isFirstPostTrialInvoice(
  invoice: StripeInvoiceProjection,
  trialEndsAt: string | null,
  trialConvertedAt: string | null,
): boolean {
  return invoice.billingReason === 'subscription_cycle'
    && trialEndsAt !== null
    && trialConvertedAt === null
    && Date.parse(invoice.createdAt) >= Date.parse(trialEndsAt);
}

export function readExpandableStripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return readStripeObjectId(value);
}

export function readStripeObjectId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function readClerkUserIdFromCheckoutSession(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as { client_reference_id?: unknown; metadata?: unknown };
  if (typeof session.client_reference_id === 'string' && CLERK_USER_ID_PATTERN.test(session.client_reference_id)) {
    return session.client_reference_id;
  }
  return readClerkUserIdFromStripeMetadata(session.metadata);
}

export function readClerkUserIdFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const clerkUserId = (metadata as { clerk_user_id?: unknown }).clerk_user_id;
  return typeof clerkUserId === 'string' && CLERK_USER_ID_PATTERN.test(clerkUserId)
    ? clerkUserId
    : null;
}

export function normalizeSubscriptionStatus(value: unknown): BillingEntitlementStatus {
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

export function epochSecondsToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}
