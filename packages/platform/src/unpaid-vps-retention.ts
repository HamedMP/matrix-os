import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { assertDeletionOwnershipSafe } from './account-deletion/cleanup-data.js';
import { AccountDeletionOwnershipError } from './account-deletion/types.js';
import { BILLING_GRACE_PERIOD_MS } from './billing.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import type { PlatformDB } from './db.js';
import { logPlatformRouteError } from './platform-route-utils.js';

const LOSS_STATUSES = ['canceled', 'past_due', 'unpaid'] as const;
const LIVE_MACHINE_STATUSES = ['running', 'suspended'] as const;
const BATCH_SIZE = 10;

interface RetentionSubscription {
  id: string;
  customerId: string;
  runtimeSlot: string;
  status: string;
  createdAt: string;
  currentPeriodStart: string | null;
  endedAt: string | null;
  latestInvoiceOutstanding: boolean;
  paidThrough: string | null;
}

interface RetentionDependencies {
  db: PlatformDB;
  policyStartsAt: Date;
  getServer: HetznerClient['getServer'];
  listSubscriptions(customerId: string): Promise<RetentionSubscription[] | null>;
  hasRecoveryCopy(ownerId: string, runtimeSlot: string): Promise<boolean>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

function dateMillis(value: string | null): number {
  return value === null ? 0 : Date.parse(value);
}

function deadline(subscription: {
  first_trial_payment_failed_at: string | null;
  trial_ends_at: string | null;
  trial_converted_at: string | null;
  current_period_end: string | null;
  grace_period_ends_at: string | null;
  latest_event_created_at: string;
}): number {
  const loss = subscription.trial_converted_at === null && subscription.trial_ends_at !== null
    ? subscription.first_trial_payment_failed_at ?? subscription.trial_ends_at
    : subscription.current_period_end ?? subscription.latest_event_created_at;
  return Math.max(dateMillis(loss) + BILLING_GRACE_PERIOD_MS, dateMillis(subscription.grace_period_ends_at));
}

function stillUnpaid(options: {
  items: RetentionSubscription[] | null;
  customerId: string;
  subscriptionId: string;
  runtimeSlot: string;
  status: string;
  policyStartsAt: number;
  unconvertedTrial: boolean;
  now: number;
}): boolean {
  const { items, customerId, subscriptionId, runtimeSlot, status, policyStartsAt, unconvertedTrial, now } = options;
  if (!items || items.some(item => item.customerId !== customerId)) return false;
  const atSlot = items.filter(item => item.runtimeSlot === runtimeSlot);
  const live = atSlot.find(item => item.id === subscriptionId);
  if (!live || live.status !== status) return false;
  if (unconvertedTrial && !(Date.parse(live.createdAt) >= policyStartsAt)) return false;
  if (atSlot.some(item => item.id !== subscriptionId && !['canceled', 'incomplete_expired'].includes(item.status))) return false;
  const loss = status === 'canceled' ? live.endedAt : live.currentPeriodStart;
  if (status !== 'canceled' && !live.latestInvoiceOutstanding) return false;
  return loss !== null && dateMillis(loss) >= policyStartsAt
    && Math.max(dateMillis(loss), dateMillis(live.paidThrough)) + BILLING_GRACE_PERIOD_MS <= now;
}

/** A bounded sweep over new-policy customers. The existing provider queue handles destructive I/O. */
export function createUnpaidVpsRetentionSweep(deps: RetentionDependencies) {
  const policyStartsAt = deps.policyStartsAt.toISOString();
  const now = deps.now ?? (() => new Date());
  let cursor: string | undefined;

  async function queueIfDue(target: {
    machine_id: string; clerk_user_id: string; runtime_slot: string; hetzner_server_id: number | null;
  }): Promise<boolean | 'backup_missing'> {
    if (!await deps.hasRecoveryCopy(target.clerk_user_id, target.runtime_slot)) return 'backup_missing';
    return deps.db.transaction(async tx => {
      await sql`SET LOCAL lock_timeout = '3000ms'`.execute(tx.executor);
      await sql`SET LOCAL statement_timeout = '10000ms'`.execute(tx.executor);
      await sql`SET LOCAL idle_in_transaction_session_timeout = '20000ms'`.execute(tx.executor);
      return withAccountDeletionOwnerLock(tx, target.clerk_user_id, async (locked, admission) => {
        if (!admission.newWorkAllowed) return false;
        const at = now();
        const machine = await locked.executor.selectFrom('user_machines')
          .select(['machine_id', 'handle', 'hetzner_server_id'])
          .where('machine_id', '=', target.machine_id).where('clerk_user_id', '=', target.clerk_user_id)
          .where('runtime_slot', '=', target.runtime_slot).where('provisioning_class', '=', 'customer')
          .where('activation_state', '=', 'authorized').where('deleted_at', 'is', null)
          .where('status', 'in', LIVE_MACHINE_STATUSES).forUpdate().executeTakeFirst();
        if (!machine?.hetzner_server_id || machine.hetzner_server_id !== target.hetzner_server_id) return false;
        const rows = await locked.executor.selectFrom('billing_subscriptions').selectAll()
          .where('clerk_user_id', '=', target.clerk_user_id).where('runtime_slot', '=', target.runtime_slot)
          .orderBy('latest_event_created_at', 'desc').orderBy('latest_event_id', 'desc').limit(129).execute();
        const subscription = rows[0];
        if (!subscription || rows.length > 128 || !LOSS_STATUSES.some(status => status === subscription.status)
          || rows.some(row => ['active', 'trialing'].includes(row.status)) || !(deadline(subscription) <= at.getTime())) return false;
        const customer = await locked.executor.selectFrom('billing_customers').select('stripe_customer_id')
          .where('clerk_user_id', '=', target.clerk_user_id).executeTakeFirst();
        if (customer?.stripe_customer_id !== subscription.stripe_customer_id
          || rows.some(row => row.stripe_customer_id !== customer.stripe_customer_id)) return false;

        const owner = target.clerk_user_id;
        const slot = target.runtime_slot;
        const serverId = machine.hetzner_server_id;
        const blocked = await sql<{ blocked: boolean }>`SELECT EXISTS (
          SELECT 1 FROM billing_entitlement_overrides WHERE clerk_user_id = ${owner} AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ${at.toISOString()})
          UNION ALL SELECT 1 FROM billing_entitlements WHERE clerk_user_id = ${owner} AND source <> 'stripe'
            AND (effective_until IS NULL OR effective_until > ${at.toISOString()})
          UNION ALL SELECT 1 FROM billing_checkout_attempts WHERE clerk_user_id = ${owner} AND runtime_slot = ${slot}
            AND status IN ('creating', 'open')
          UNION ALL SELECT 1 FROM billing_runtime_actions WHERE machine_id = ${target.machine_id} AND status IN ('queued', 'running')
          UNION ALL SELECT 1 FROM provider_deletion_queue WHERE provider_server_id = ${serverId} AND completed_at IS NULL
        ) AS blocked`.execute(locked.executor);
        if (blocked.rows[0]?.blocked) return false;
        try {
          await assertDeletionOwnershipSafe(locked, owner);
        } catch (error: unknown) {
          if (error instanceof AccountDeletionOwnershipError) return false;
          throw error;
        }

        const [items, server] = await Promise.all([deps.listSubscriptions(customer.stripe_customer_id), deps.getServer(serverId)]);
        if (!server || server.id !== serverId || server.deleteProtected !== false || !['running', 'off'].includes(server.status)
          || server.labels?.app !== 'matrix-os' || server.labels.machine_id !== machine.machine_id
          || server.labels.clerk_user_id !== owner || server.labels.runtime_slot !== slot) return false;
        if (!stillUnpaid({ items, customerId: customer.stripe_customer_id, subscriptionId: subscription.stripe_subscription_id,
          runtimeSlot: slot, status: subscription.status, policyStartsAt: deps.policyStartsAt.getTime(),
          unconvertedTrial: subscription.trial_ends_at !== null && subscription.trial_converted_at === null,
          now: at.getTime() })) return false;

        const deletedAt = now().toISOString();
        const changed = await locked.executor.updateTable('user_machines').set({ status: 'deleted', deleted_at: deletedAt })
          .where('machine_id', '=', machine.machine_id).where('hetzner_server_id', '=', serverId)
          .where('deleted_at', 'is', null).returning('handle').executeTakeFirst();
        if (!changed) return false;
        await locked.executor.insertInto('provider_deletion_queue').values({ id: randomUUID(), provider_server_id: serverId,
          machine_id: machine.machine_id, handle: changed.handle, reason: 'unpaid_retention', attempts: 0,
          next_attempt_at: deletedAt, created_at: deletedAt, last_error: null, completed_at: null }).execute();
        return true;
      }, deps.env);
    });
  }

  return async () => {
    const at = now();
    if (at < deps.policyStartsAt) return { checked: 0, queued: 0, failed: 0, backupMissing: 0 };
    const targets = await deps.db.executor.selectFrom('user_machines as m')
      .select(['m.machine_id', 'm.clerk_user_id', 'm.runtime_slot', 'm.hetzner_server_id'])
      .where('m.provisioning_class', '=', 'customer').where('m.activation_state', '=', 'authorized')
      .where('m.deleted_at', 'is', null).where('m.hetzner_server_id', 'is not', null)
      .where('m.status', 'in', LIVE_MACHINE_STATUSES)
      .$if(cursor !== undefined, query => query.where('m.machine_id', '>', cursor!))
      .where(eb => {
        const unpaid = eb.selectFrom('billing_subscriptions as s').select('s.stripe_subscription_id')
          .whereRef('s.clerk_user_id', '=', 'm.clerk_user_id').whereRef('s.runtime_slot', '=', 'm.runtime_slot')
          .where('s.status', 'in', LOSS_STATUSES).where('s.latest_event_created_at', '>=', policyStartsAt)
          .where(billing => billing.or([
            billing('s.grace_period_ends_at', 'is', null), billing('s.grace_period_ends_at', '<=', at.toISOString()),
          ]));
        return eb.exists(unpaid);
      })
      .orderBy('m.machine_id').limit(BATCH_SIZE).execute();
    cursor = targets.length === BATCH_SIZE ? targets.at(-1)?.machine_id : undefined;
    let queued = 0;
    let failed = 0;
    let backupMissing = 0;
    for (const target of targets) {
      try {
        const outcome = await queueIfDue(target);
        if (outcome === true) queued += 1;
        if (outcome === 'backup_missing') backupMissing += 1;
      } catch (error: unknown) {
        failed += 1;
        logPlatformRouteError('unpaid VPS retention', error);
      }
    }
    return { checked: targets.length, queued, failed, backupMissing };
  };
}
