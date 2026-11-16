import { MATRIX_FREE_PLAN } from '@matrix-os/contracts';
import type { BillingEntitlement } from '../billing.js';

/** The free plan's runtime always occupies the primary slot. */
export const FREE_RUNTIME_SLOT = 'primary';

export function buildFreeEntitlement(clerkUserId: string, now: Date): BillingEntitlement {
  const at = now.toISOString();
  return {
    clerkUserId,
    source: 'free',
    planSlug: MATRIX_FREE_PLAN.slug,
    status: 'active',
    maxRuntimeSlots: MATRIX_FREE_PLAN.maxRuntimeSlots,
    includedRuntimeSlots: MATRIX_FREE_PLAN.maxRuntimeSlots,
    addonRuntimeSlots: 0,
    defaultServerType: '',
    allowedServerTypes: [],
    stripeSubscriptionId: null,
    stripePriceId: null,
    billingInterval: null,
    gracePeriodEndsAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialConvertedAt: null,
    firstTrialPaymentFailedAt: null,
    effectiveFrom: at,
    effectiveUntil: null,
    updatedAt: at,
  };
}

/**
 * Slot-scoped resolution reads Stripe subscriptions, which a free owner has
 * none of. The stored free entitlement stands in for the free runtime's slot
 * only; a stored paid entitlement never does, so paid resolution is unchanged.
 */
export function freeEntitlementForSlot(
  stored: BillingEntitlement | null,
  runtimeSlot: string,
): BillingEntitlement | null {
  return stored?.source === 'free' && runtimeSlot === FREE_RUNTIME_SLOT ? stored : null;
}

const ENDED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'ended', 'none']);

function notAhead(at: string | null | undefined, now: Date): boolean {
  return !at || Date.parse(at) <= now.getTime();
}

/**
 * The entitlement for one slot, given the slot's subscription projected as an
 * entitlement (or null when the slot has none). A former paid owner keeps
 * their ended subscription row after taking the free plan; once that
 * subscription grants nothing (an ended status with no grace period or
 * effective end still ahead) the stored free entitlement stands for the free
 * runtime's slot. A live subscription still wins, and owners without a stored
 * free entitlement resolve exactly as before.
 */
export function entitlementForSlot(
  stored: BillingEntitlement | null,
  runtimeSlot: string,
  subscription: BillingEntitlement | null,
  now: Date,
): BillingEntitlement | null {
  const free = freeEntitlementForSlot(stored, runtimeSlot);
  if (!subscription) return free;
  const ended = ENDED_SUBSCRIPTION_STATUSES.has(subscription.status)
    && notAhead(subscription.gracePeriodEndsAt, now) && notAhead(subscription.effectiveUntil, now);
  return free && ended ? free : subscription;
}
