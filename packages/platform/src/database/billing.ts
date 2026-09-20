import { sql } from 'kysely';
import type {
  BillingCustomerRecord,
  BillingSubscriptionRecord,
  NewBillingCustomer,
  NewBillingSubscription,
  PlatformDB,
} from '../db.js';
import type { BillingEntitlementStatus, MatrixBillingInterval } from '../billing.js';
import {
  mapBillingCustomer,
  mapBillingSubscription,
  toBillingCustomerRow,
  toBillingSubscriptionRow,
} from './billing-records.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): billing customer and subscription queries. */

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
