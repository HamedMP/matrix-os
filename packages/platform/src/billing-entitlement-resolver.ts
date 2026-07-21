import {
  getBillingEntitlementState,
  getBillingSubscription,
  type PlatformDB,
} from './db.js';
import {
  computeEffectiveEntitlement,
  deriveStripeEntitlement,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  parseBillingEntitlementRecord,
  parseBillingOverrideRecord,
  type BillingEntitlement,
} from './billing.js';

export async function resolveEffectiveBillingEntitlementForSlot(
  db: PlatformDB,
  clerkUserId: string,
  now: Date,
  runtimeSlot?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BillingEntitlement | null> {
  const state = await getBillingEntitlementState(db, clerkUserId, now.toISOString());
  const override = parseBillingOverrideRecord(state.override);
  let stripeEntitlement = parseBillingEntitlementRecord(state.entitlement);
  if (runtimeSlot && !override) {
    const subscription = await getBillingSubscription(db, clerkUserId, runtimeSlot, now.toISOString());
    stripeEntitlement = subscription
      ? deriveStripeEntitlement({
        clerkUserId: subscription.clerkUserId,
        stripeCustomerId: subscription.stripeCustomerId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        items: [{ priceId: subscription.stripePriceId, quantity: 1 }],
      }, {
        priceCatalog: loadStripePriceCatalog(env),
        runtimeCatalog: loadRuntimeCatalog(env),
        now,
      })
      : null;
  }
  return computeEffectiveEntitlement({
    stripeEntitlement,
    override,
    now,
  });
}
