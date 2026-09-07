import type { MatrixBillingManagement, MatrixBillingPublicEntitlement } from '#billing-public';
import { MATRIX_HOSTED_BILLING_PLANS } from '#billing-catalog';

/** Shared copy and semantics for every billing renderer. Never use this for authorization. */
export function deriveBillingManagementView(
  entitlement: MatrixBillingPublicEntitlement | null | undefined,
  management?: MatrixBillingManagement,
  accessReason?: string | null,
) {
  const subscription = management
    ? management.subscription
    : entitlement?.source === 'stripe' ? entitlement : null;
  const teamAccess = entitlement?.source === 'override';
  const portalAvailable = management?.portalAvailable ?? entitlement?.portalAvailable === true;
  const placement = management ? management.runtimePlacement : entitlement?.runtimePlacement;
  const legacyAccess = accessReason === 'legacy_clerk_plan';
  const planName = subscription
    ? MATRIX_HOSTED_BILLING_PLANS.find((plan) => plan.slug === subscription.planSlug)?.label ?? 'Subscription'
    : teamAccess ? 'Team-provided access' : legacyAccess ? 'Legacy plan' : 'No subscription';
  const interval = subscription?.billingInterval;
  const recurringPrice = subscription?.recurringPrice;
  const billingLabel = recurringPrice
    ? formatRecurringPrice(recurringPrice)
    : interval === 'annual' ? 'Annual' : interval === 'monthly' ? 'Monthly'
    : management && !subscription ? 'No subscription' : 'Not available';
  const status = subscription?.status ?? (teamAccess ? entitlement.status : legacyAccess ? 'active' : null);
  const statusLabel = status ? status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ') : 'No subscription';
  const allowanceLabel = entitlement ? `Up to ${entitlement.maxRuntimeSlots} computers` : 'Not available';
  const portalMessage = portalAvailable
    ? 'Manage your subscription, invoices, and payment methods in the billing portal.'
    : 'Billing management is not available for this account yet. Contact the Matrix team for billing help.';
  const accessDescription = teamAccess
    ? 'The Matrix team provides runtime access for this account.'
    : 'Runtime access follows your subscription and any applicable grace period.';
  const trialEndsAt = subscription?.status === 'trialing' ? subscription.trialEndsAt : null;
  const paymentRequired = Boolean(subscription?.firstTrialPaymentFailedAt && !subscription.trialConvertedAt);
  return {
    subscription, teamAccess, portalAvailable, planName, statusLabel, billingLabel,
    allowanceLabel, portalMessage, accessDescription, trialEndsAt, paymentRequired,
    computerCount: management?.computerCount ?? null,
    locationLabel: placement?.label ?? 'Not available',
    countryLabel: placement?.countryLabel ?? '',
  };
}

function formatRecurringPrice(price: NonNullable<MatrixBillingPublicEntitlement['recurringPrice']>): string {
  // Read currency minor units before changing display precision (JPY uses zero, KWD three).
  const currency = price.currency.toUpperCase();
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const amount = new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 0 })
    .format(price.unitAmountMinor * price.quantity / 10 ** digits);
  const unit = price.interval === 'monthly' ? 'month' : 'year';
  const period = price.intervalCount === 1 ? unit : `${price.intervalCount} ${unit}s`;
  return `${amount}/${period}`;
}
