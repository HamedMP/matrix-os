/** Operator-only reviewed deletion intents. Never mount on a route or a scheduled worker. */
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import type { TrialRetentionProviderTarget } from './trial-retention-provider.js';

const DAY = 86_400_000;
const Reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Timestamp = z.iso.datetime({ offset: true });
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const ExpiredTrialCleanupReviewSchema = z.object({
  version: z.literal(1), sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  authorizationReference: Reference, issuedAt: Timestamp, expiresAt: Timestamp,
  targets: z.array(z.object({ ownerId: Reference, machineId: z.uuid(), serverId: z.number().int().positive(),
    subscriptionId: Reference, noticeGivenAt: Timestamp, noticeReference: Reference }).strict()).min(1).max(5),
}).strict().refine(review => new Set(review.targets.map(target => target.ownerId)).size === review.targets.length
  && new Set(review.targets.map(target => target.serverId)).size === review.targets.length, 'Duplicate cleanup identity');
const Mode = z.object({ apply: z.boolean().optional(), reviewedFingerprint: Fingerprint.optional() }).strict();
export interface ExpiredTrialCleanupResult { mode: 'dry-run' | 'queued'; fingerprint: string; targetCount: number }
function requireSafe(value: unknown): asserts value {
  if (!value) throw new Error('Expired trial cleanup refused; review current eligibility');
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function listExpiredTrialMachines(db: PlatformDB, now: Date, limit = 50) {
  requireSafe(Number.isFinite(now.getTime()) && Number.isInteger(limit) && limit >= 1 && limit <= 100);
  await db.ready;
  const result = await sql<{ ownerId: string; machineId: string; serverId: number; subscriptionId: string;
    planSlug: string; trialEndsAt: string }>`
    SELECT m.clerk_user_id AS "ownerId", m.machine_id AS "machineId", m.hetzner_server_id AS "serverId",
      s.stripe_subscription_id AS "subscriptionId", s.plan_slug AS "planSlug", s.trial_ends_at AS "trialEndsAt"
    FROM user_machines m JOIN billing_subscriptions s ON s.clerk_user_id=m.clerk_user_id AND s.runtime_slot=m.runtime_slot
    WHERE m.runtime_slot='primary' AND m.provisioning_class='customer' AND m.status='suspended'
      AND m.deleted_at IS NULL AND m.hetzner_server_id IS NOT NULL AND s.status='canceled'
      AND s.trial_started_at IS NOT NULL AND s.trial_ends_at <= ${new Date(now.getTime() - 7 * DAY).toISOString()}
      AND s.trial_converted_at IS NULL AND (s.grace_period_ends_at IS NULL OR s.grace_period_ends_at < ${now.toISOString()})
      AND NOT EXISTS (SELECT 1 FROM billing_subscriptions p WHERE p.clerk_user_id=m.clerk_user_id
        AND (p.trial_converted_at IS NOT NULL OR p.status NOT IN ('canceled', 'incomplete_expired')))
      AND NOT EXISTS (SELECT 1 FROM billing_entitlement_overrides o WHERE o.clerk_user_id=m.clerk_user_id
        AND o.revoked_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > ${now.toISOString()}))
      AND NOT EXISTS (SELECT 1 FROM billing_entitlements e WHERE e.clerk_user_id=m.clerk_user_id
        AND (e.source <> 'stripe' OR e.trial_converted_at IS NOT NULL OR e.status NOT IN ('canceled', 'incomplete_expired')))
    ORDER BY s.trial_ends_at, m.machine_id LIMIT ${limit}
  `.execute(db.executor);
  return result.rows.map(row => ({ ...row, earliestDeleteAt: new Date(Date.parse(row.trialEndsAt) + 7 * DAY).toISOString() }));
}

export async function prepareExpiredTrialCleanup(options: {
  db: PlatformDB; sourceSha: string; now?: () => Date; env?: NodeJS.ProcessEnv;
  verifyProvider(target: TrialRetentionProviderTarget): Promise<void>;
}, input: unknown, modeInput: { apply?: boolean; reviewedFingerprint?: string } = {}): Promise<ExpiredTrialCleanupResult> {
  const review = ExpiredTrialCleanupReviewSchema.parse(input); const mode = Mode.parse(modeInput);
  const env = { ...(options.env ?? process.env) }; const apply = mode.apply === true;
  const clock = options.now ?? (() => new Date()); const began = clock().getTime(); const monotonic = performance.now();
  const now = () => new Date(Math.max(clock().getTime(), began + performance.now() - monotonic));
  const assertFresh = () => {
    const current = now().getTime(); const issued = Date.parse(review.issuedAt); const expires = Date.parse(review.expiresAt);
    requireSafe(Number.isFinite(current) && issued <= current && current < expires && expires - issued <= 5 * 60_000);
    requireSafe(review.targets.every(target => Date.parse(target.noticeGivenAt) + 7 * DAY <= current));
  };
  requireSafe(review.sourceSha === options.sourceSha && (!apply || mode.reviewedFingerprint)); assertFresh();
  // Operator attestation of a fresh authenticated deployment check, not an inferred feature flag.
  requireSafe(!apply || env.MATRIX_TRIAL_RETENTION_DEPLOYED_SOURCE_SHA === review.sourceSha);
  const targets = [...review.targets].sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  return options.db.transaction(async trx => {
    await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx.executor);
    if (!apply) await sql`SET TRANSACTION READ ONLY`.execute(trx.executor);
    await sql`SET LOCAL lock_timeout = '3000ms'`.execute(trx.executor);
    await sql`SET LOCAL statement_timeout = '10000ms'`.execute(trx.executor);
    await sql`SET LOCAL idle_in_transaction_session_timeout = '20000ms'`.execute(trx.executor);
    // Keep the same account-deletion -> billing-owner ordering as webhook and entitlement writers.
    for (const target of targets) await withAccountDeletionOwnerLock(trx, target.ownerId, async (_locked, admission) => {
      requireSafe(admission.newWorkAllowed);
    }, env);
    if (env.ACCOUNT_DELETION_SECRET === undefined) {
      requireSafe(!await trx.executor.selectFrom('account_deletion_jobs').select('owner_hash')
        .where('status', '!=', 'cancelled').limit(1).executeTakeFirst());
    }
    const lock = <T extends { forUpdate(): T }>(query: T): T => apply ? query.forUpdate() : query;
    const snapshots: unknown[] = [];
    for (const target of targets) {
      assertFresh();
      const subscriptions = await lock(trx.executor.selectFrom('billing_subscriptions').selectAll()
        .where('clerk_user_id', '=', target.ownerId).orderBy('stripe_subscription_id').limit(129)).execute();
      const entitlements = await lock(trx.executor.selectFrom('billing_entitlements').selectAll()
        .where('clerk_user_id', '=', target.ownerId)).execute();
      const overrides = await lock(trx.executor.selectFrom('billing_entitlement_overrides').selectAll()
        .where('clerk_user_id', '=', target.ownerId).orderBy('id').limit(129)).execute();
      const machines = await lock(trx.executor.selectFrom('user_machines').selectAll()
        .where('hetzner_server_id', '=', target.serverId).orderBy('machine_id').limit(3)).execute();
      const machine = machines.find(row => row.machine_id === target.machineId);
      const subscription = subscriptions.find(row => row.stripe_subscription_id === target.subscriptionId);
      const at = now().getTime();
      requireSafe(subscriptions.length <= 128 && overrides.length <= 128 && machines.length === 1
        && machine && machine.clerk_user_id === target.ownerId && machine.runtime_slot === 'primary'
        && machine.provisioning_class === 'customer' && machine.status === 'suspended' && machine.deleted_at === null
        && machine.activation_state === 'authorized'
        && subscription && subscription.status === 'canceled' && subscription.runtime_slot === 'primary'
        && subscription.trial_started_at !== null && subscription.trial_ends_at !== null
        && Date.parse(subscription.trial_started_at) < Date.parse(subscription.trial_ends_at)
        && Date.parse(subscription.trial_ends_at) + 7 * DAY <= at
        && (subscription.grace_period_ends_at === null || Date.parse(subscription.grace_period_ends_at) < at));
      requireSafe(subscriptions.every(row => row.trial_converted_at === null && ['canceled', 'incomplete_expired'].includes(row.status))
        && entitlements.every(row => row.source === 'stripe' && row.trial_converted_at === null
          && ['canceled', 'incomplete_expired'].includes(row.status))
        && overrides.every(row => row.revoked_at !== null || (row.expires_at !== null && Date.parse(row.expires_at) <= at)));
      const customer = await lock(trx.executor.selectFrom('billing_customers').selectAll()
        .where('clerk_user_id', '=', target.ownerId)).executeTakeFirst();
      requireSafe(customer && customer.stripe_customer_id === subscription.stripe_customer_id
        && subscriptions.every(row => row.stripe_customer_id === customer.stripe_customer_id));
      const actions = await lock(trx.executor.selectFrom('billing_runtime_actions').select('id')
        .where('machine_id', '=', target.machineId).where('status', 'in', ['queued', 'running'])).limit(1).execute();
      const pending = await lock(trx.executor.selectFrom('provider_deletion_queue').select('id')
        .where('provider_server_id', '=', target.serverId).where('completed_at', 'is', null)).limit(1).execute();
      const checkout = await lock(trx.executor.selectFrom('billing_checkout_attempts').select('id')
        .where('clerk_user_id', '=', target.ownerId).where('status', 'in', ['creating', 'open'])).limit(1).execute();
      const paidCredit = await trx.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
        .where('owner_id', '=', target.ownerId).where('kind', '=', 'addon_grant').limit(1).executeTakeFirst();
      requireSafe(actions.length === 0 && pending.length === 0 && checkout.length === 0 && !paidCredit);
      await options.verifyProvider({ ...target, customerId: customer.stripe_customer_id, trialEndsAt: subscription.trial_ends_at });
      // A late reflected conversion is denied even when a caller supplied a stale preflight implementation.
      const finalSubscription = await trx.executor.selectFrom('billing_subscriptions').selectAll()
        .where('stripe_subscription_id', '=', target.subscriptionId).executeTakeFirst();
      requireSafe(JSON.stringify(finalSubscription) === JSON.stringify(subscription));
      snapshots.push({ machine, subscriptions, entitlements, overrides, customer });
    }
    assertFresh();
    const fingerprint = hash({ review, snapshots });
    requireSafe(!apply || mode.reviewedFingerprint === fingerprint);
    if (apply) for (const target of targets) {
      assertFresh(); const deletedAt = now().toISOString();
      const changed = await trx.executor.updateTable('user_machines').set({ status: 'deleted', deleted_at: deletedAt })
        .where('machine_id', '=', target.machineId).where('clerk_user_id', '=', target.ownerId)
        .where('hetzner_server_id', '=', target.serverId).where('status', '=', 'suspended').where('deleted_at', 'is', null)
        .returning('handle').executeTakeFirst();
      requireSafe(changed);
      await trx.executor.insertInto('provider_deletion_queue').values({ id: randomUUID(), provider_server_id: target.serverId,
        machine_id: target.machineId, handle: changed.handle, reason: 'expired_trial', attempts: 0,
        next_attempt_at: deletedAt, created_at: deletedAt, last_error: null, completed_at: null }).execute();
    }
    return { mode: apply ? 'queued' : 'dry-run', fingerprint, targetCount: targets.length };
  });
}
