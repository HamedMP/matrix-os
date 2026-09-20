import { sql } from 'kysely';
import type {
  BillingEntitlementOverrideRecord,
  BillingEntitlementOverridesTable,
  BillingEntitlementRecord,
  BillingEntitlementsTable,
  BillingEntitlementStateRecord,
  BillingWebhookEventRecord,
  NewBillingEntitlement,
  NewBillingEntitlementOverride,
  NewBillingWebhookEvent,
  PlatformDB,
} from '../db.js';
import {
  mapBillingEntitlement,
  mapBillingOverride,
  mapBillingWebhookEvent,
  toBillingEntitlementRow,
  toBillingOverrideRow,
  toBillingWebhookEventRow,
} from './billing-records.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): billing entitlement, override and webhook event queries. */

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
