/**
 * Billing customer/subscription/entitlement/webhook persistence.
 *
 * Extracted from ../db.ts (Phase 1-A2). Pure move: no logic changes.
 */
import { sql } from 'kysely';
import type {
  BillingEntitlementSource,
  BillingEntitlementStatus,
  MatrixBillingInterval,
  MatrixBillingPlanSlug,
} from '../billing.js';
import type {
  BillingCheckoutAttemptsTable,
  BillingCustomersTable,
  BillingEntitlementOverridesTable,
  BillingEntitlementsTable,
  BillingSubscriptionsTable,
  BillingWebhookEventsTable,
  PlatformDatabase,
  PlatformDB,
} from './schema-tables.js';
import type {
  BillingCheckoutAttemptRecord,
  BillingCustomerRecord,
  BillingEntitlementOverrideRecord,
  BillingEntitlementRecord,
  BillingEntitlementStateRecord,
  BillingSubscriptionRecord,
  BillingWebhookEventRecord,
  NewBillingCustomer,
  NewBillingEntitlement,
  NewBillingEntitlementOverride,
  NewBillingSubscription,
  NewBillingWebhookEvent,
} from './schema-records.js';

export function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

function mapBillingCustomer(row: BillingCustomersTable): BillingCustomerRecord {
  return {
    clerkUserId: row.clerk_user_id,
    stripeCustomerId: row.stripe_customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBillingCustomerRow(record: NewBillingCustomer): BillingCustomersTable {
  return {
    clerk_user_id: record.clerkUserId,
    stripe_customer_id: record.stripeCustomerId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function mapBillingEntitlement(row: BillingEntitlementsTable): BillingEntitlementRecord {
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

function toBillingEntitlementRow(record: NewBillingEntitlement): BillingEntitlementsTable {
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

function mapBillingSubscription(row: BillingSubscriptionsTable): BillingSubscriptionRecord {
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

function toBillingSubscriptionRow(record: NewBillingSubscription): BillingSubscriptionsTable {
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

function mapBillingOverride(row: BillingEntitlementOverridesTable): BillingEntitlementOverrideRecord {
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

function toBillingOverrideRow(record: NewBillingEntitlementOverride): BillingEntitlementOverridesTable {
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

function mapBillingWebhookEvent(row: BillingWebhookEventsTable): BillingWebhookEventRecord {
  return {
    stripeEventId: row.stripe_event_id,
    eventType: row.event_type,
    createdAtFromStripe: row.created_at_from_stripe,
    processedAt: row.processed_at,
    status: row.status,
    errorCode: row.error_code,
  };
}

function toBillingWebhookEventRow(record: NewBillingWebhookEvent): BillingWebhookEventsTable {
  return {
    stripe_event_id: record.stripeEventId,
    event_type: record.eventType,
    created_at_from_stripe: record.createdAtFromStripe,
    processed_at: record.processedAt,
    status: record.status,
    error_code: record.errorCode,
  };
}


export async function upsertBillingCustomer(db: PlatformDB, record: NewBillingCustomer): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_customers')
    .values(toBillingCustomerRow(record))
    .onConflict((oc) => oc.column('clerk_user_id').doUpdateSet({
      stripe_customer_id: record.stripeCustomerId,
      updated_at: record.updatedAt,
    }))
    .execute();
}

export async function insertBillingCustomerIfAbsent(db: PlatformDB, record: NewBillingCustomer): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_customers')
    .values(toBillingCustomerRow(record))
    .onConflict((oc) => oc.column('clerk_user_id').doNothing())
    .execute();
}

export async function getBillingCustomerByClerkUserId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<BillingCustomerRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_customers')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapBillingCustomer(row) : undefined;
}

export async function getBillingCustomerByStripeCustomerId(
  db: PlatformDB,
  stripeCustomerId: string,
): Promise<BillingCustomerRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_customers')
    .selectAll()
    .where('stripe_customer_id', '=', stripeCustomerId)
    .executeTakeFirst();
  return row ? mapBillingCustomer(row) : undefined;
}

export async function hasBillingSubscriptionHistory(
  db: PlatformDB,
  clerkUserId: string,
): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_subscriptions')
    .select('stripe_subscription_id')
    .where('clerk_user_id', '=', clerkUserId)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

export async function upsertBillingSubscription(db: PlatformDB, record: NewBillingSubscription): Promise<boolean> {
  await db.ready;
  const row = toBillingSubscriptionRow(record);
  const applied = await db.executor
    .insertInto('billing_subscriptions')
    .values(row)
    .onConflict((oc) => oc.column('stripe_subscription_id').doUpdateSet({
      stripe_customer_id: row.stripe_customer_id,
      clerk_user_id: row.clerk_user_id,
      runtime_slot: row.runtime_slot,
      plan_slug: row.plan_slug,
      stripe_price_id: row.stripe_price_id,
      billing_interval: row.billing_interval,
      price_unit_amount_minor: sql<number | null>`CASE
        WHEN billing_subscriptions.stripe_price_id = EXCLUDED.stripe_price_id
          THEN COALESCE(EXCLUDED.price_unit_amount_minor, billing_subscriptions.price_unit_amount_minor)
        ELSE EXCLUDED.price_unit_amount_minor
      END`,
      price_currency: sql<string | null>`CASE
        WHEN billing_subscriptions.stripe_price_id = EXCLUDED.stripe_price_id
          THEN COALESCE(EXCLUDED.price_currency, billing_subscriptions.price_currency)
        ELSE EXCLUDED.price_currency
      END`,
      price_interval_count: sql<number | null>`CASE
        WHEN billing_subscriptions.stripe_price_id = EXCLUDED.stripe_price_id
          THEN COALESCE(EXCLUDED.price_interval_count, billing_subscriptions.price_interval_count)
        ELSE EXCLUDED.price_interval_count
      END`,
      price_quantity: sql<number | null>`CASE
        WHEN billing_subscriptions.stripe_price_id = EXCLUDED.stripe_price_id
          THEN COALESCE(EXCLUDED.price_quantity, billing_subscriptions.price_quantity)
        ELSE EXCLUDED.price_quantity
      END`,
      status: row.status,
      current_period_end: row.current_period_end,
      grace_period_ends_at: row.grace_period_ends_at,
      trial_started_at: sql<string | null>`COALESCE(
        billing_subscriptions.trial_started_at,
        EXCLUDED.trial_started_at
      )`,
      trial_ends_at: sql<string | null>`COALESCE(
        billing_subscriptions.trial_ends_at,
        EXCLUDED.trial_ends_at
      )`,
      trial_converted_at: sql<string | null>`COALESCE(
        billing_subscriptions.trial_converted_at,
        EXCLUDED.trial_converted_at
      )`,
      first_trial_payment_failed_at: sql<string | null>`CASE
        WHEN billing_subscriptions.trial_converted_at IS NOT NULL
          OR EXCLUDED.trial_converted_at IS NOT NULL
          THEN NULL
        ELSE COALESCE(
          billing_subscriptions.first_trial_payment_failed_at,
          EXCLUDED.first_trial_payment_failed_at
        )
      END`,
      latest_event_created_at: row.latest_event_created_at,
      latest_event_id: row.latest_event_id,
      updated_at: row.updated_at,
    }).where((eb) => eb.or([
      eb('billing_subscriptions.latest_event_created_at', '<', row.latest_event_created_at),
      eb.and([
        eb('billing_subscriptions.latest_event_created_at', '=', row.latest_event_created_at),
        eb('billing_subscriptions.latest_event_id', '<', row.latest_event_id),
      ]),
    ])))
    .returning('stripe_subscription_id')
    .executeTakeFirst();
  return Boolean(applied);
}

export async function persistBillingSubscriptionPriceSnapshot(
  db: PlatformDB,
  input: {
    stripeSubscriptionId: string;
    expectedStripePriceId: string;
    unitAmountMinor: number;
    currency: string;
    interval: MatrixBillingInterval;
    intervalCount: number;
    quantity: number;
    updatedAt: string;
  },
): Promise<boolean> {
  await db.ready;
  const updated = await db.executor
    .updateTable('billing_subscriptions')
    .set({
      price_unit_amount_minor: input.unitAmountMinor,
      price_currency: input.currency,
      billing_interval: input.interval,
      price_interval_count: input.intervalCount,
      price_quantity: input.quantity,
      updated_at: input.updatedAt,
    })
    .where('stripe_subscription_id', '=', input.stripeSubscriptionId)
    .where('stripe_price_id', '=', input.expectedStripePriceId)
    .returning('stripe_subscription_id')
    .executeTakeFirst();
  return Boolean(updated);
}

export async function getBillingSubscription(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
  atIso: string,
): Promise<BillingSubscriptionRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .orderBy(sql<number>`CASE
      WHEN billing_subscriptions.status IN ('active', 'trialing') THEN 0
      WHEN billing_subscriptions.grace_period_ends_at IS NOT NULL
        AND billing_subscriptions.grace_period_ends_at >= ${atIso} THEN 1
      ELSE 2
    END`)
    .orderBy('latest_event_created_at', 'desc')
    .orderBy('latest_event_id', 'desc')
    .executeTakeFirst();
  return row ? mapBillingSubscription(row) : undefined;
}

export async function getBillingSubscriptionByStripeId(
  db: PlatformDB,
  stripeSubscriptionId: string,
): Promise<BillingSubscriptionRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('stripe_subscription_id', '=', stripeSubscriptionId)
    .executeTakeFirst();
  return row ? mapBillingSubscription(row) : undefined;
}

export interface TrialInvoiceEventProjectionResult {
  applied: boolean;
  lifecycleChanged: boolean;
  subscription: BillingSubscriptionRecord;
}

/**
 * Projects a conversion-invoice event under a dedicated monotonic cursor with
 * the same timestamp-and-ID ordering used by subscription webhooks. Keeping
 * the cursors separate prevents a later subscription projection from hiding a
 * valid invoice transition. Callers run this inside the webhook transaction,
 * so the row lock also serializes competing invoice deliveries.
 */
export async function projectTrialInvoiceEvent(
  db: PlatformDB,
  input: {
    stripeSubscriptionId: string;
    type: 'invoice.paid' | 'invoice.payment_failed';
    eventCreatedAt: string;
    eventId: string;
    lifecycleAt: string;
    updatedAt: string;
  },
): Promise<TrialInvoiceEventProjectionResult | undefined> {
  await db.ready;
  const currentRow = await db.executor
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('stripe_subscription_id', '=', input.stripeSubscriptionId)
    .forUpdate()
    .executeTakeFirst();
  if (!currentRow || currentRow.trial_ends_at === null) return undefined;

  const subscriptionCursorIsNewer = currentRow.latest_event_created_at > input.eventCreatedAt
    || (
      currentRow.latest_event_created_at === input.eventCreatedAt
      && currentRow.latest_event_id > input.eventId
    );
  if (
    subscriptionCursorIsNewer
    && !subscriptionStatusAcceptsOlderTrialInvoice(currentRow.status, input.type)
  ) {
    return {
      applied: false,
      lifecycleChanged: false,
      subscription: mapBillingSubscription(currentRow),
    };
  }

  const eventIsNewer = currentRow.latest_invoice_event_created_at === null
    || currentRow.latest_invoice_event_created_at < input.eventCreatedAt
    || (
      currentRow.latest_invoice_event_created_at === input.eventCreatedAt
      && (currentRow.latest_invoice_event_id === null || currentRow.latest_invoice_event_id < input.eventId)
    );
  if (!eventIsNewer) {
    return {
      applied: false,
      lifecycleChanged: false,
      subscription: mapBillingSubscription(currentRow),
    };
  }

  const paymentFailed = input.type === 'invoice.payment_failed';
  const lifecycleChanged = paymentFailed
    ? currentRow.trial_converted_at === null && currentRow.first_trial_payment_failed_at === null
    : currentRow.trial_converted_at === null;
  const invoiceCursorCreatedAt = currentRow.latest_invoice_event_created_at;
  const invoiceCursorId = currentRow.latest_invoice_event_id;
  const row = await db.executor
    .updateTable('billing_subscriptions')
    .set({
      trial_converted_at: !paymentFailed && lifecycleChanged
        ? input.lifecycleAt
        : currentRow.trial_converted_at,
      first_trial_payment_failed_at: paymentFailed && lifecycleChanged
        ? input.lifecycleAt
        : (!paymentFailed && lifecycleChanged ? null : currentRow.first_trial_payment_failed_at),
      grace_period_ends_at: paymentFailed && lifecycleChanged
        ? null
        : currentRow.grace_period_ends_at,
      latest_invoice_event_created_at: input.eventCreatedAt,
      latest_invoice_event_id: input.eventId,
      updated_at: input.updatedAt,
    })
    .where('stripe_subscription_id', '=', input.stripeSubscriptionId)
    .$if(invoiceCursorCreatedAt === null, (query) => (
      query.where('latest_invoice_event_created_at', 'is', null)
    ))
    .$if(invoiceCursorCreatedAt !== null, (query) => (
      query.where('latest_invoice_event_created_at', '=', invoiceCursorCreatedAt ?? '')
    ))
    .$if(invoiceCursorId === null, (query) => (
      query.where('latest_invoice_event_id', 'is', null)
    ))
    .$if(invoiceCursorId !== null, (query) => (
      query.where('latest_invoice_event_id', '=', invoiceCursorId ?? '')
    ))
    .returningAll()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    applied: true,
    lifecycleChanged,
    subscription: mapBillingSubscription(row),
  };
}

function subscriptionStatusAcceptsOlderTrialInvoice(
  status: string,
  type: 'invoice.paid' | 'invoice.payment_failed',
): boolean {
  if (type === 'invoice.paid') return status === 'active';
  return status === 'past_due'
    || status === 'unpaid'
    || status === 'canceled'
    || status === 'ended'
    || status === 'incomplete'
    || status === 'incomplete_expired'
    || status === 'paused';
}

export async function listCurrentBillingSubscriptions(
  db: PlatformDB,
  clerkUserId: string,
  atIso: string,
): Promise<BillingSubscriptionRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('billing_subscriptions')
    .distinctOn('runtime_slot')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .orderBy('runtime_slot', 'asc')
    .orderBy(sql<number>`CASE
      WHEN billing_subscriptions.status IN ('active', 'trialing') THEN 0
      WHEN billing_subscriptions.grace_period_ends_at IS NOT NULL
        AND billing_subscriptions.grace_period_ends_at >= ${atIso} THEN 1
      ELSE 2
    END`)
    .orderBy('latest_event_created_at', 'desc')
    .orderBy('latest_event_id', 'desc')
    .execute();
  return rows.map(mapBillingSubscription);
}

export async function upsertBillingEntitlement(db: PlatformDB, record: NewBillingEntitlement): Promise<void> {
  await db.ready;
  const row = toBillingEntitlementRow(record);
  await db.executor
    .insertInto('billing_entitlements')
    .values(row)
    .onConflict((oc) => oc.column('clerk_user_id').doUpdateSet({
      source: row.source,
      plan_slug: row.plan_slug,
      status: row.status,
      max_runtime_slots: row.max_runtime_slots,
      included_runtime_slots: row.included_runtime_slots,
      addon_runtime_slots: row.addon_runtime_slots,
      default_server_type: row.default_server_type,
      allowed_server_types: row.allowed_server_types,
      stripe_subscription_id: row.stripe_subscription_id,
      stripe_price_id: row.stripe_price_id,
      billing_interval: row.billing_interval,
      grace_period_ends_at: row.grace_period_ends_at,
      trial_started_at: row.trial_started_at,
      trial_ends_at: row.trial_ends_at,
      trial_converted_at: row.trial_converted_at,
      first_trial_payment_failed_at: row.first_trial_payment_failed_at,
      effective_from: row.effective_from,
      effective_until: row.effective_until,
      updated_at: row.updated_at,
    }).where('billing_entitlements.updated_at', '<=', row.updated_at))
    .execute();
}

export async function getBillingEntitlement(
  db: PlatformDB,
  clerkUserId: string,
): Promise<BillingEntitlementRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_entitlements')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapBillingEntitlement(row) : undefined;
}

export async function upsertBillingOverride(db: PlatformDB, record: NewBillingEntitlementOverride): Promise<void> {
  await db.ready;
  const row = toBillingOverrideRow(record);
  await db.executor
    .insertInto('billing_entitlement_overrides')
    .values(row)
    .onConflict((oc) => oc.column('id').doUpdateSet({
      plan_slug: row.plan_slug,
      status: row.status,
      max_runtime_slots: row.max_runtime_slots,
      included_runtime_slots: row.included_runtime_slots,
      addon_runtime_slots: row.addon_runtime_slots,
      default_server_type: row.default_server_type,
      allowed_server_types: row.allowed_server_types,
      reason: row.reason,
      created_by: row.created_by,
      expires_at: row.expires_at,
    }))
    .execute();
}

export async function getBillingOverride(
  db: PlatformDB,
  clerkUserId: string,
  nowIso = new Date().toISOString(),
): Promise<BillingEntitlementOverrideRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_entitlement_overrides')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([
      eb('expires_at', 'is', null),
      eb('expires_at', '>', nowIso),
    ]))
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapBillingOverride(row) : undefined;
}

export async function getBillingEntitlementState(
  db: PlatformDB,
  clerkUserId: string,
  nowIso = new Date().toISOString(),
): Promise<BillingEntitlementStateRecord> {
  await db.ready;
  const result = await sql<{
    entitlement: BillingEntitlementsTable | null;
    override: BillingEntitlementOverridesTable | null;
  }>`
    SELECT
      (
        SELECT row_to_json(e)
        FROM billing_entitlements e
        WHERE e.clerk_user_id = ${clerkUserId}
      ) AS entitlement,
      (
        SELECT row_to_json(o)
        FROM billing_entitlement_overrides o
        WHERE o.clerk_user_id = ${clerkUserId}
          AND o.revoked_at IS NULL
          AND (o.expires_at IS NULL OR o.expires_at > ${nowIso})
        ORDER BY o.created_at DESC
        LIMIT 1
      ) AS override
  `.execute(db.executor);
  const row = result.rows[0];
  return {
    entitlement: row?.entitlement ? mapBillingEntitlement(row.entitlement) : undefined,
    override: row?.override ? mapBillingOverride(row.override) : undefined,
  };
}

export async function revokeBillingOverride(db: PlatformDB, id: string, revokedAt: string): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .updateTable('billing_entitlement_overrides')
    .set({ revoked_at: revokedAt })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return Boolean(row);
}

export async function insertBillingWebhookEvent(
  db: PlatformDB,
  record: NewBillingWebhookEvent,
): Promise<{ inserted: boolean }> {
  await db.ready;
  const result = await db.executor
    .insertInto('billing_webhook_events')
    .values(toBillingWebhookEventRow(record))
    .onConflict((oc) => oc.column('stripe_event_id').doNothing())
    .returning('stripe_event_id')
    .executeTakeFirst();
  return { inserted: Boolean(result?.stripe_event_id) };
}

export async function getBillingWebhookEvent(
  db: PlatformDB,
  stripeEventId: string,
): Promise<BillingWebhookEventRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_webhook_events')
    .selectAll()
    .where('stripe_event_id', '=', stripeEventId)
    .executeTakeFirst();
  return row ? mapBillingWebhookEvent(row) : undefined;
}
