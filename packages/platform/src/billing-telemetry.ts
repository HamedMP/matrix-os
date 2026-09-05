import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { MATRIX_HOSTED_BILLING_REGIONS, type MatrixHostedBillingRegionSlug } from '@matrix-os/contracts';
import type { BillingEntitlement, StripeSubscriptionProjection } from './billing.js';
import type { PlatformDB, UserMachineRecord } from './db.js';

type CaptureOptions = { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> };

/** Request-local staging: discard on rollback, publish only after commit. */
export function stageBillingTelemetry(stripeEventId: string, stripeEventType: string) {
  const pending: { event: string; options: CaptureOptions }[] = [];
  return {
    capture(event: string, options: CaptureOptions = {}) {
      // A Stripe webhook has a bounded number of lifecycle emissions.
      if (pending.length >= 16) throw new Error('billing_telemetry_capacity');
      pending.push({ event, options: { ...options, properties: {
        ...options.properties,
        delivery_key: createHash('sha256').update(`billing:${stripeEventId}:${event}`).digest('hex'),
        stripe_event_type: stripeEventType,
      } } });
    },
    flush(emit: (event: string, options: CaptureOptions) => void) {
      for (const item of pending.splice(0)) emit(item.event, item.options);
    },
  };
}

/** Serializes first-insert and update comparisons under the enclosing transaction. */
export async function lockBillingTelemetrySubscription(db: PlatformDB, subscriptionId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`billing-subscription:${subscriptionId}`}))`.execute(db.executor);
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

