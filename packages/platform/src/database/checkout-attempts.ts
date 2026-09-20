import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  BillingCheckoutAttemptRecord,
  BillingCheckoutAttemptStatus,
  BillingCheckoutAttemptsTable,
  PlatformDB,
} from '../db.js';
import type { MatrixBillingInterval, MatrixBillingPlanSlug } from '../billing.js';
import {
  DEFAULT_DEVELOPER_TOOLS,
  parseDeveloperToolsJson,
  serializeDeveloperTools,
  type DeveloperToolId,
} from '../developer-tools.js';
import { mapCheckoutAttempt } from './billing-records.js';

/** Extracted verbatim from packages/platform/src/db.ts (S01 / T007): billing checkout attempt claims and settlement. */

const CHECKOUT_IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

const CHECKOUT_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export async function insertCheckoutAttempt(
  db: PlatformDB,
  record: {
    id: string;
    clerkUserId: string;
    stripeSessionId: string;
    runtimeSlot?: string;
    planSlug?: MatrixBillingPlanSlug;
    billingInterval?: MatrixBillingInterval;
    regionSlug?: string;
    serverType?: string;
    trialPeriodDays?: number | null;
    createdAt: string;
    status?: BillingCheckoutAttemptStatus;
    resolvedAt?: string | null;
    developerTools?: DeveloperToolId[];
  },
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_checkout_attempts')
    .values({
      id: record.id,
      clerk_user_id: record.clerkUserId,
      stripe_session_id: record.stripeSessionId,
      checkout_url: null,
      runtime_slot: record.runtimeSlot ?? 'primary',
      plan_slug: record.planSlug ?? null,
      billing_interval: record.billingInterval ?? null,
      region_slug: record.regionSlug ?? null,
      server_type: record.serverType ?? null,
      trial_period_days: record.trialPeriodDays ?? null,
      developer_tools: serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
      status: record.status ?? 'open',
      created_at: record.createdAt,
      resolved_at: record.resolvedAt ?? null,
    })
    .onConflict((oc) => oc.column('stripe_session_id').doNothing())
    .execute();
}

export interface BillingCheckoutClaimInput {
  id: string;
  clerkUserId: string;
  runtimeSlot: string;
  planSlug: MatrixBillingPlanSlug;
  billingInterval: MatrixBillingInterval;
  regionSlug: string;
  serverType?: string;
  trialPeriodDays?: number | null;
  developerTools?: DeveloperToolId[];
  createdAt: string;
}

export async function claimCheckoutAttempt(
  db: PlatformDB,
  record: BillingCheckoutClaimInput,
  transactionAlreadyOpen = false,
): Promise<{ attempt: BillingCheckoutAttemptRecord; claimed: boolean; selectionMatches: boolean }> {
  await db.ready;
  const row: BillingCheckoutAttemptsTable = {
    id: record.id,
    clerk_user_id: record.clerkUserId,
    stripe_session_id: null,
    checkout_url: null,
    runtime_slot: record.runtimeSlot,
    plan_slug: record.planSlug,
    billing_interval: record.billingInterval,
    region_slug: record.regionSlug,
    server_type: record.serverType ?? null,
    trial_period_days: record.trialPeriodDays ?? null,
    developer_tools: serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
    status: 'creating',
    created_at: record.createdAt,
    resolved_at: null,
  };
  const tryInsert = async (): Promise<BillingCheckoutAttemptsTable | undefined> => db.executor
    .insertInto('billing_checkout_attempts')
    .values(row)
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  const getActiveAttempt = async (): Promise<BillingCheckoutAttemptsTable | undefined> => db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', record.clerkUserId)
    .where('runtime_slot', '=', record.runtimeSlot)
    .where('status', 'in', ['creating', 'open'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  const inserted = await tryInsert();
  if (inserted) return { attempt: mapCheckoutAttempt(inserted), claimed: true, selectionMatches: true };
  let activeRow = await getActiveAttempt();
  if (!activeRow) throw new Error('active checkout claim conflict could not be reconciled');
  const activeAgeMs = Date.parse(record.createdAt) - Date.parse(activeRow.created_at);
  const isExpiredLegacyAttempt = activeRow.status === 'open'
    && (
      activeRow.plan_slug === null
      || activeRow.billing_interval === null
      || activeRow.region_slug === null
    )
    && Number.isFinite(activeAgeMs)
    && activeAgeMs >= CHECKOUT_SESSION_MAX_LIFETIME_MS;
  if (isExpiredLegacyAttempt) {
    // Stripe Checkout Sessions cannot remain payable beyond 24 hours. Legacy
    // rows predate persisted selection fields, so retiring only after that
    // provider window avoids replacing a session that may still accept payment.
    const legacyAttemptId = activeRow.id;
    const legacyCutoff = new Date(
      Date.parse(record.createdAt) - CHECKOUT_SESSION_MAX_LIFETIME_MS,
    ).toISOString();
    const replaceLegacyAttempt = async (trx: PlatformDB) => {
      const retired = await trx.executor
        .updateTable('billing_checkout_attempts')
        .set({ status: 'abandoned', resolved_at: record.createdAt })
        .where('id', '=', legacyAttemptId)
        .where('status', '=', 'open')
        .where('created_at', '<=', legacyCutoff)
        .where((eb) => eb.or([
          eb('plan_slug', 'is', null),
          eb('billing_interval', 'is', null),
          eb('region_slug', 'is', null),
        ]))
        .returning('id')
        .executeTakeFirst();
      if (!retired) return undefined;
      return trx.executor
        .insertInto('billing_checkout_attempts')
        .values(row)
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .executeTakeFirst();
    };
    const replacement = transactionAlreadyOpen
      ? await replaceLegacyAttempt(db)
      : await db.transaction(replaceLegacyAttempt);
    if (replacement) {
      return { attempt: mapCheckoutAttempt(replacement), claimed: true, selectionMatches: true };
    }
    activeRow = await getActiveAttempt();
    if (!activeRow) throw new Error('legacy checkout replacement conflict could not be reconciled');
  }
  const sameSelection = activeRow.plan_slug === record.planSlug
    && activeRow.billing_interval === record.billingInterval
    && activeRow.region_slug === record.regionSlug
    && activeRow.server_type === (record.serverType ?? null)
    && activeRow.trial_period_days === (record.trialPeriodDays ?? null)
    && activeRow.developer_tools
      === serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS);
  const retryAgeMs = Date.parse(record.createdAt) - Date.parse(activeRow.created_at);
  const withinIdempotencyWindow = Number.isFinite(retryAgeMs)
    && retryAgeMs >= 0
    && retryAgeMs <= CHECKOUT_IDEMPOTENCY_RETRY_WINDOW_MS;
  if (activeRow.status === 'creating' && sameSelection && withinIdempotencyWindow) {
    // A previous Stripe response may have timed out after creating the
    // provider session. Re-run with this persisted attempt id so Stripe's
    // idempotency key reconciles the ambiguous result instead of creating a
    // second Checkout Session.
    return { attempt: mapCheckoutAttempt(activeRow), claimed: true, selectionMatches: true };
  }
  // Never replace a provider session that may still be payable, and never
  // retry after Stripe may have pruned the idempotency key. Resolution then
  // requires the signed provider lifecycle or an operator reconciliation.
  return { attempt: mapCheckoutAttempt(activeRow), claimed: false, selectionMatches: sameSelection };
}

export async function claimCardTrialCheckoutAttempt(
  db: PlatformDB,
  record: Omit<BillingCheckoutClaimInput, 'trialPeriodDays'>,
  durationDays: number,
): Promise<{ attempt: BillingCheckoutAttemptRecord; claimed: boolean; selectionMatches: boolean }> {
  await db.ready;
  return db.transaction(async (trx) => {
    await trx.executor
      .insertInto('billing_trial_accounts')
      .values({
        clerk_user_id: record.clerkUserId,
        trial_checkout_attempt_id: null,
        consumed_at: null,
        updated_at: record.createdAt,
      })
      .onConflict((oc) => oc.column('clerk_user_id').doNothing())
      .execute();
    const account = await trx.executor
      .selectFrom('billing_trial_accounts')
      .selectAll()
      .where('clerk_user_id', '=', record.clerkUserId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    let reservedAttempt: BillingCheckoutAttemptsTable | undefined;
    if (account.trial_checkout_attempt_id) {
      reservedAttempt = await trx.executor
        .selectFrom('billing_checkout_attempts')
        .selectAll()
        .where('id', '=', account.trial_checkout_attempt_id)
        .executeTakeFirst();
      if (!reservedAttempt || !['creating', 'open'].includes(reservedAttempt.status)) {
        await trx.executor
          .updateTable('billing_trial_accounts')
          .set({ trial_checkout_attempt_id: null, updated_at: record.createdAt })
          .where('clerk_user_id', '=', record.clerkUserId)
          .where('trial_checkout_attempt_id', '=', account.trial_checkout_attempt_id)
          .execute();
        reservedAttempt = undefined;
      }
    }
    const historicalSubscription = await trx.executor
      .selectFrom('billing_subscriptions')
      .select('stripe_subscription_id')
      .where('clerk_user_id', '=', record.clerkUserId)
      .limit(1)
      .executeTakeFirst();
    const trialPeriodDays = reservedAttempt?.trial_period_days
      ?? (!account.consumed_at && !historicalSubscription ? durationDays : null);
    const result = await claimCheckoutAttempt(trx, { ...record, trialPeriodDays }, true);
    if (result.attempt.trialPeriodDays) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({
          trial_checkout_attempt_id: result.attempt.id,
          updated_at: record.createdAt,
        })
        .where('clerk_user_id', '=', record.clerkUserId)
        .where('consumed_at', 'is', null)
        .execute();
    }
    return result;
  });
}

export async function isCardTrialOfferEligible(
  db: PlatformDB,
  clerkUserId: string,
): Promise<boolean> {
  await db.ready;
  const [account, historicalSubscription] = await Promise.all([
    db.executor
      .selectFrom('billing_trial_accounts')
      .select(['consumed_at', 'trial_checkout_attempt_id'])
      .where('clerk_user_id', '=', clerkUserId)
      .executeTakeFirst(),
    db.executor
      .selectFrom('billing_subscriptions')
      .select('stripe_subscription_id')
      .where('clerk_user_id', '=', clerkUserId)
      .limit(1)
      .executeTakeFirst(),
  ]);
  return !account?.consumed_at && !historicalSubscription;
}

export async function consumeCardTrial(
  db: PlatformDB,
  clerkUserId: string,
  consumedAt: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_trial_accounts')
    .values({
      clerk_user_id: clerkUserId,
      trial_checkout_attempt_id: null,
      consumed_at: consumedAt,
      updated_at: consumedAt,
    })
    .onConflict((oc) => oc.column('clerk_user_id').doUpdateSet({
      trial_checkout_attempt_id: null,
      consumed_at: sql<string>`COALESCE(billing_trial_accounts.consumed_at, ${consumedAt})`,
      updated_at: consumedAt,
    }))
    .execute();
}

export async function finalizeCheckoutAttempt(
  db: PlatformDB,
  id: string,
  stripeSessionId: string,
  checkoutUrl: string,
): Promise<boolean> {
  await db.ready;
  const updated = await db.executor
    .updateTable('billing_checkout_attempts')
    .set({ stripe_session_id: stripeSessionId, checkout_url: checkoutUrl, status: 'open' })
    .where('id', '=', id)
    .where('status', '=', 'creating')
    .returning('id')
    .executeTakeFirst();
  if (updated) return true;
  const existing = await db.executor
    .selectFrom('billing_checkout_attempts')
    .select(['stripe_session_id', 'checkout_url', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  return existing?.status === 'open'
    && existing.stripe_session_id === stripeSessionId
    && existing.checkout_url === checkoutUrl;
}

export async function abandonCreatingCheckoutAttempt(
  db: PlatformDB,
  id: string,
  resolvedAt: string,
): Promise<boolean> {
  await db.ready;
  return db.transaction(async (trx) => {
    const abandoned = await trx.executor
      .updateTable('billing_checkout_attempts')
      .set({ status: 'abandoned', resolved_at: resolvedAt })
      .where('id', '=', id)
      .where('status', '=', 'creating')
      .where('stripe_session_id', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!abandoned) return false;
    await trx.executor
      .updateTable('billing_trial_accounts')
      .set({ trial_checkout_attempt_id: null, updated_at: resolvedAt })
      .where('trial_checkout_attempt_id', '=', id)
      .execute();
    return true;
  });
}

export async function getLatestCheckoutAttempt(
  db: PlatformDB,
  clerkUserId: string,
): Promise<BillingCheckoutAttemptRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapCheckoutAttempt(row) : undefined;
}

export async function getActiveCheckoutAttempt(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
): Promise<BillingCheckoutAttemptRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', 'in', ['creating', 'open'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapCheckoutAttempt(row) : undefined;
}

/**
 * The attempt that governs payment settling: a confirmed `paid` attempt always
 * wins over a newer still-`open` one, so a paying user who opens a second
 * checkout before activation is never bounced back to plan selection. Terminal
 * (`expired`/`abandoned`) attempts never sustain settling and are excluded.
 */

export async function getSettlingCheckoutAttempt(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot?: string,
): Promise<BillingCheckoutAttemptRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('status', 'in', ['paid', 'open']);
  if (runtimeSlot) query = query.where('runtime_slot', '=', runtimeSlot);
  const row = await query
    .orderBy(sql`CASE status WHEN 'paid' THEN 0 ELSE 1 END`)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapCheckoutAttempt(row) : undefined;
}

/** Resolves an open checkout attempt by Stripe session id. Only transitions
 * `open` rows so a later/duplicate webhook cannot rewrite a terminal state. */

export async function resolveCheckoutAttempt(
  db: PlatformDB,
  stripeSessionId: string,
  status: 'paid' | 'expired',
  resolvedAt: string,
  transactionAlreadyOpen = false,
): Promise<void> {
  await db.ready;
  const resolve = async (trx: PlatformDB) => {
    const updated = await trx.executor
      .updateTable('billing_checkout_attempts')
      .set({ status, resolved_at: resolvedAt })
      .where('stripe_session_id', '=', stripeSessionId)
      .where('status', '=', 'open')
      .returning('id')
      .executeTakeFirst();
    if (status === 'expired' && updated) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({ trial_checkout_attempt_id: null, updated_at: resolvedAt })
        .where('trial_checkout_attempt_id', '=', updated.id)
        .execute();
    } else if (status === 'paid' && updated) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({
          trial_checkout_attempt_id: null,
          consumed_at: sql<string>`COALESCE(billing_trial_accounts.consumed_at, ${resolvedAt})`,
          updated_at: resolvedAt,
        })
        .where('trial_checkout_attempt_id', '=', updated.id)
        .execute();
    }
  };
  if (transactionAlreadyOpen) await resolve(db);
  else await db.transaction(resolve);
}

/** Sweeps stale open provider sessions after their payment window has elapsed.
 * `creating` claims are deliberately retained: an ambiguous Stripe response
 * must be retried with the same persisted idempotency key. */

export async function sweepStaleCheckoutAttempts(
  db: PlatformDB,
  openOlderThanIso: string,
  resolvedAt: string,
  limit: number,
): Promise<number> {
  await db.ready;
  return db.transaction(async (trx) => {
    const stale = await trx.executor
      .selectFrom('billing_checkout_attempts')
      .select('id')
      .where('status', '=', 'open')
      .where('created_at', '<', openOlderThanIso)
      .limit(limit)
      .execute();
    if (stale.length === 0) return 0;
    const updated = await trx.executor
      .updateTable('billing_checkout_attempts')
      .set({ status: 'abandoned', resolved_at: resolvedAt })
      .where('id', 'in', stale.map((r) => r.id))
      // Re-check status in the UPDATE: a concurrent webhook may have resolved the
      // row to paid/expired between the SELECT and here; never overwrite it.
      .where('status', '=', 'open')
      .returning('id')
      .execute();
    if (updated.length > 0) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({ trial_checkout_attempt_id: null, updated_at: resolvedAt })
        .where('trial_checkout_attempt_id', 'in', updated.map((row) => row.id))
        .execute();
    }
    return updated.length;
  });
}
