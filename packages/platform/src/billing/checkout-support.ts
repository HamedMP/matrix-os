import {
  MATRIX_HOSTED_BILLING_REGIONS,
  type MatrixBillingPublicEntitlement,
  type MatrixHostedBillingRegionSlug,
} from '@matrix-os/contracts';
import { appOrigin, resolveReturnPath } from '../origins.js';
import {
  persistBillingSubscriptionPriceSnapshot,
  type BillingSubscriptionRecord,
  type PlatformDB,
  type UserMachineRecord,
} from '../db.js';
import {
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  type BillingEntitlement,
  type MatrixBillingInterval,
  type MatrixBillingPlanSlug,
  type StripeSubscriptionProjection,
} from '../billing.js';
import { MATRIX_CARD_TRIAL_DAYS, MatrixCardTrialDaysSchema, type CheckoutRequest } from './checkout-schemas.js';
import { MAX_STRIPE_API_TIMEOUT_MS, type StripeBillingClient } from './stripe-client.js';

/** Extracted verbatim from packages/platform/src/billing-routes.ts (S01 / T007): checkout telemetry, price and return-URL helpers. */

export function resolveCardTrialDays(env: NodeJS.ProcessEnv): number {
  const configured = env.MATRIX_CARD_TRIAL_DAYS;
  if (configured === undefined) return MATRIX_CARD_TRIAL_DAYS;
  const parsed = MatrixCardTrialDaysSchema.safeParse(configured);
  if (!parsed.success) {
    throw new Error('MATRIX_CARD_TRIAL_DAYS must be an integer from 1 to 30');
  }
  return parsed.data;
}

export function resolvePriceId(
  env: NodeJS.ProcessEnv,
  planSlug: MatrixBillingPlanSlug,
  interval: MatrixBillingInterval,
): string | undefined {
  const key = `STRIPE_PRICE_${planSlug.toUpperCase()}_${interval.toUpperCase()}`;
  return env[key];
}

export function buildCheckoutTelemetryProperties(data: CheckoutRequest): Record<string, string | number | boolean | undefined> {
  return {
    plan_slug: data.planSlug,
    billing_interval: data.interval,
    region_slug: data.regionSlug,
    return_path_present: Boolean(data.returnPath),
    developer_tools_count: data.developerTools.length,
    selected_catalog_price_usd: planPriceUsd(data.planSlug, data.interval),
    utm_source: data.attribution?.utm_source,
    utm_medium: data.attribution?.utm_medium,
    utm_campaign: data.attribution?.utm_campaign,
    utm_content: data.attribution?.utm_content,
    utm_term: data.attribution?.utm_term,
    reddit_click_present: Boolean(data.attribution?.rdt_cid),
  };
}

export function storedRecurringPrice(
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

export async function resolvePublicRecurringPrice(
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

export function buildSubscriptionTelemetryProperties(input: {
  entitlement: BillingEntitlement;
  recurringItem: StripeSubscriptionProjection['items'][number] | undefined;
  runtimeSlot: string;
  regionSlug: MatrixHostedBillingRegionSlug | null;
  machine: Pick<UserMachineRecord, 'serverType' | 'location' | 'hetznerServerId'> | undefined;
}): Record<string, string | number | boolean | undefined> {
  const { entitlement, recurringItem, runtimeSlot, machine } = input;
  const planSlug = entitlement.planSlug === 'internal' ? undefined : entitlement.planSlug;
  const placement = resolveRuntimePlacement(machine?.location, input.regionSlug);
  const hasRecurringPrice = recurringItem?.unitAmountMinor !== null
    && recurringItem?.unitAmountMinor !== undefined
    && recurringItem.currency !== null
    && recurringItem.currency !== undefined
    && recurringItem.interval !== null
    && recurringItem.interval !== undefined
    && recurringItem.intervalCount !== null
    && recurringItem.intervalCount !== undefined
    && recurringItem.quantity !== null
    && recurringItem.quantity !== undefined;
  return {
    plan_slug: planSlug,
    subscription_status: entitlement.status,
    billing_interval: recurringItem?.interval ?? entitlement.billingInterval ?? undefined,
    ...(hasRecurringPrice ? {
      recurring_unit_amount_minor: recurringItem.unitAmountMinor!,
      recurring_total_amount_minor: recurringItem.unitAmountMinor! * recurringItem.quantity!,
      currency: recurringItem.currency!,
      price_interval_count: recurringItem.intervalCount!,
      price_quantity: recurringItem.quantity!,
    } : {}),
    runtime_slot: runtimeSlot,
    ...(placement ? {
      region_slug: placement.slug,
      location_code: placement.location,
      location_label: placement.label,
      country: placement.countryLabel,
      network_zone: placement.networkZone,
    } : {}),
    ...(machine?.serverType ? { server_type: machine.serverType } : {}),
    ...(machine ? { provider: 'hetzner' } : {}),
    included_runtime_slots: entitlement.includedRuntimeSlots,
    addon_runtime_slots: entitlement.addonRuntimeSlots,
    max_runtime_slots: entitlement.maxRuntimeSlots,
  };
}

export function resolveRuntimePlacement(
  machineLocation: string | null | undefined,
  fallbackRegionSlug: MatrixHostedBillingRegionSlug | null = null,
) {
  return MATRIX_HOSTED_BILLING_REGIONS.find((region) => region.location === machineLocation)
    ?? MATRIX_HOSTED_BILLING_REGIONS.find((region) => region.slug === fallbackRegionSlug)
    ?? null;
}

export function planPriceUsd(planSlug: MatrixBillingPlanSlug, interval: MatrixBillingInterval): number | undefined {
  const plan = DEFAULT_BILLING_PLAN_DEFINITIONS.find((candidate) => candidate.slug === planSlug);
  if (!plan) return undefined;
  return interval === 'monthly' ? plan.monthlyUsd : undefined;
}

export function resolveBillingReturnUrl(
  env: NodeJS.ProcessEnv,
  state: 'success' | 'canceled' | 'portal',
  returnPath?: string,
): string {
  const appUrl = appOrigin(env);
  if (returnPath && state === 'portal') {
    return new URL(resolveReturnPath(returnPath), new URL(appUrl).origin).toString();
  }
  if (returnPath && state !== 'portal') {
    const appBase = new URL(appUrl);
    // resolveReturnPath is the authoritative allowlist guard — never build the
    // redirect from the raw client path (off-allowlist values collapse to "/").
    const url = new URL(resolveReturnPath(returnPath), appBase.origin);
    url.searchParams.set('billing', state);
    if (state === 'success') url.searchParams.set('checkout', 'success');
    return url.toString();
  }
  if (state === 'success' && env.STRIPE_CHECKOUT_SUCCESS_URL) return env.STRIPE_CHECKOUT_SUCCESS_URL;
  if (state === 'canceled' && env.STRIPE_CHECKOUT_CANCEL_URL) return env.STRIPE_CHECKOUT_CANCEL_URL;
  if (state === 'portal' && env.STRIPE_PORTAL_RETURN_URL) return env.STRIPE_PORTAL_RETURN_URL;
  const url = new URL(appUrl);
  url.searchParams.set('billing', state);
  if (state === 'success') url.searchParams.set('checkout', 'success');
  return url.toString();
}
