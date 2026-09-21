import type { Insertable, Selectable } from 'kysely';
import type {
  BillingCheckoutAttemptRecord,
  BillingCheckoutAttemptStatus,
  BillingCheckoutAttemptsTable,
  BillingCustomerRecord,
  BillingCustomersTable,
  BillingEntitlementOverrideRecord,
  BillingEntitlementOverridesTable,
  BillingEntitlementRecord,
  BillingEntitlementsTable,
  BillingSubscriptionRecord,
  BillingSubscriptionsTable,
  BillingWebhookEventRecord,
  BillingWebhookEventsTable,
  NewBillingCustomer,
  NewBillingEntitlement,
  NewBillingEntitlementOverride,
  NewBillingSubscription,
  NewBillingWebhookEvent,
} from '../db.js';
import type { BillingEntitlementSource, BillingEntitlementStatus, MatrixBillingInterval, MatrixBillingPlanSlug } from '../billing.js';
import { parseDeveloperToolsJson } from '../developer-tools.js';
import { parseStringArray } from './json.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): billing row mappers. */

export function mapBillingCustomer(row: BillingCustomersTable): BillingCustomerRecord {
  return {
    clerkUserId: row.clerk_user_id,
    stripeCustomerId: row.stripe_customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toBillingCustomerRow(record: NewBillingCustomer): BillingCustomersTable {
  return {
    clerk_user_id: record.clerkUserId,
    stripe_customer_id: record.stripeCustomerId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function mapBillingEntitlement(row: BillingEntitlementsTable): BillingEntitlementRecord {
  return {
    clerkUserId: row.clerk_user_id,
    source: row.source as BillingEntitlementSource,
    planSlug: row.plan_slug as MatrixBillingPlanSlug | 'internal',
    status: row.status as BillingEntitlementStatus,
    maxRuntimeSlots: row.max_runtime_slots,
    includedRuntimeSlots: row.included_runtime_slots,
    addonRuntimeSlots: row.addon_runtime_slots,
    defaultServerType: row.default_server_type,
    allowedServerTypes: parseStringArray(row.allowed_server_types),
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    billingInterval: row.billing_interval as MatrixBillingInterval | null,
    gracePeriodEndsAt: row.grace_period_ends_at,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    trialConvertedAt: row.trial_converted_at,
    firstTrialPaymentFailedAt: row.first_trial_payment_failed_at,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    updatedAt: row.updated_at,
  };
}

export function toBillingEntitlementRow(record: NewBillingEntitlement): BillingEntitlementsTable {
  return {
    clerk_user_id: record.clerkUserId,
    source: record.source,
    plan_slug: record.planSlug,
    status: record.status,
    max_runtime_slots: record.maxRuntimeSlots,
    included_runtime_slots: record.includedRuntimeSlots,
    addon_runtime_slots: record.addonRuntimeSlots,
    default_server_type: record.defaultServerType,
    allowed_server_types: JSON.stringify(record.allowedServerTypes),
    stripe_subscription_id: record.stripeSubscriptionId,
    stripe_price_id: record.stripePriceId,
    billing_interval: record.billingInterval ?? null,
    grace_period_ends_at: record.gracePeriodEndsAt,
    trial_started_at: record.trialStartedAt ?? null,
    trial_ends_at: record.trialEndsAt ?? null,
    trial_converted_at: record.trialConvertedAt ?? null,
    first_trial_payment_failed_at: record.firstTrialPaymentFailedAt ?? null,
    effective_from: record.effectiveFrom,
    effective_until: record.effectiveUntil,
    updated_at: record.updatedAt,
  };
}

export function mapBillingSubscription(row: BillingSubscriptionsTable): BillingSubscriptionRecord {
  return {
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeCustomerId: row.stripe_customer_id,
    clerkUserId: row.clerk_user_id,
    runtimeSlot: row.runtime_slot,
    planSlug: row.plan_slug as MatrixBillingPlanSlug,
    stripePriceId: row.stripe_price_id,
    billingInterval: row.billing_interval as MatrixBillingInterval | null,
    priceUnitAmountMinor: row.price_unit_amount_minor,
    priceCurrency: row.price_currency,
    priceIntervalCount: row.price_interval_count,
    priceQuantity: row.price_quantity,
    status: row.status as BillingEntitlementStatus,
    currentPeriodEnd: row.current_period_end,
    gracePeriodEndsAt: row.grace_period_ends_at,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    trialConvertedAt: row.trial_converted_at,
    firstTrialPaymentFailedAt: row.first_trial_payment_failed_at,
    latestEventCreatedAt: row.latest_event_created_at,
    latestEventId: row.latest_event_id,
    updatedAt: row.updated_at,
  };
}

export function toBillingSubscriptionRow(record: NewBillingSubscription): BillingSubscriptionsTable {
  return {
    stripe_subscription_id: record.stripeSubscriptionId,
    stripe_customer_id: record.stripeCustomerId,
    clerk_user_id: record.clerkUserId,
    runtime_slot: record.runtimeSlot,
    plan_slug: record.planSlug,
    stripe_price_id: record.stripePriceId,
    billing_interval: record.billingInterval,
    price_unit_amount_minor: record.priceUnitAmountMinor ?? null,
    price_currency: record.priceCurrency ?? null,
    price_interval_count: record.priceIntervalCount ?? null,
    price_quantity: record.priceQuantity ?? null,
    status: record.status,
    current_period_end: record.currentPeriodEnd,
    grace_period_ends_at: record.gracePeriodEndsAt,
    trial_started_at: record.trialStartedAt ?? null,
    trial_ends_at: record.trialEndsAt ?? null,
    trial_converted_at: record.trialConvertedAt ?? null,
    first_trial_payment_failed_at: record.firstTrialPaymentFailedAt ?? null,
    latest_event_created_at: record.latestEventCreatedAt,
    latest_event_id: record.latestEventId,
    latest_invoice_event_created_at: null,
    latest_invoice_event_id: null,
    updated_at: record.updatedAt,
  };
}

export function mapBillingOverride(row: BillingEntitlementOverridesTable): BillingEntitlementOverrideRecord {
  return {
    id: row.id,
    clerkUserId: row.clerk_user_id,
    planSlug: row.plan_slug as MatrixBillingPlanSlug | 'internal',
    status: row.status as 'active',
    maxRuntimeSlots: row.max_runtime_slots,
    includedRuntimeSlots: row.included_runtime_slots,
    addonRuntimeSlots: row.addon_runtime_slots,
    defaultServerType: row.default_server_type,
    allowedServerTypes: parseStringArray(row.allowed_server_types),
    reason: row.reason,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function toBillingOverrideRow(record: NewBillingEntitlementOverride): BillingEntitlementOverridesTable {
  return {
    id: record.id,
    clerk_user_id: record.clerkUserId,
    plan_slug: record.planSlug,
    status: record.status,
    max_runtime_slots: record.maxRuntimeSlots,
    included_runtime_slots: record.includedRuntimeSlots,
    addon_runtime_slots: record.addonRuntimeSlots,
    default_server_type: record.defaultServerType,
    allowed_server_types: JSON.stringify(record.allowedServerTypes),
    reason: record.reason,
    created_by: record.createdBy,
    expires_at: record.expiresAt,
    revoked_at: record.revokedAt,
    created_at: record.createdAt,
  };
}

export function mapBillingWebhookEvent(row: BillingWebhookEventsTable): BillingWebhookEventRecord {
  return {
    stripeEventId: row.stripe_event_id,
    eventType: row.event_type,
    createdAtFromStripe: row.created_at_from_stripe,
    processedAt: row.processed_at,
    status: row.status,
    errorCode: row.error_code,
  };
}

export function toBillingWebhookEventRow(record: NewBillingWebhookEvent): BillingWebhookEventsTable {
  return {
    stripe_event_id: record.stripeEventId,
    event_type: record.eventType,
    created_at_from_stripe: record.createdAtFromStripe,
    processed_at: record.processedAt,
    status: record.status,
    error_code: record.errorCode,
  };
}

export function isCheckoutAttemptStatus(value: string): value is BillingCheckoutAttemptStatus {
  return value === 'creating' || value === 'open' || value === 'paid' || value === 'expired' || value === 'abandoned';
}

export function mapCheckoutAttempt(row: BillingCheckoutAttemptsTable): BillingCheckoutAttemptRecord {
  return {
    id: row.id,
    clerkUserId: row.clerk_user_id,
    stripeSessionId: row.stripe_session_id,
    checkoutUrl: row.checkout_url,
    runtimeSlot: row.runtime_slot,
    planSlug: row.plan_slug as MatrixBillingPlanSlug | null,
    billingInterval: row.billing_interval as MatrixBillingInterval | null,
    regionSlug: row.region_slug,
    serverType: row.server_type,
    trialPeriodDays: row.trial_period_days,
    status: isCheckoutAttemptStatus(row.status) ? row.status : 'open',
    developerTools: parseDeveloperToolsJson(row.developer_tools),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
