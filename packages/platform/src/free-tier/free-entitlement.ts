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
