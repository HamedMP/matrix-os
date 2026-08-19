import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { PlatformDB } from './db.js';

export type BillingRuntimeAction = 'suspend' | 'resume';
export type BillingRuntimeActionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface BillingRuntimeActionRecord {
  id: string;
  machineId: string;
  stripeSubscriptionId: string;
  action: BillingRuntimeAction;
  reason: 'trial_payment_failed' | 'trial_ended_unpaid' | 'payment_recovered';
  status: BillingRuntimeActionStatus;
  executeAfter: string;
  attempts: number;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface BillingRuntimeActionRow {
  id: string;
  machine_id: string;
  stripe_subscription_id: string;
  action: string;
  reason: string;
  status: string;
  execute_after: string;
  attempts: number;
  claimed_at: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapBillingRuntimeAction(row: BillingRuntimeActionRow): BillingRuntimeActionRecord {
  return {
    id: row.id,
    machineId: row.machine_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    action: row.action as BillingRuntimeAction,
    reason: row.reason as BillingRuntimeActionRecord['reason'],
    status: row.status as BillingRuntimeActionStatus,
    executeAfter: row.execute_after,
    attempts: row.attempts,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function enqueueBillingRuntimeAction(
  db: PlatformDB,
  input: {
    clerkUserId: string;
    runtimeSlot: string;
    stripeSubscriptionId: string;
    action: BillingRuntimeAction;
    reason: BillingRuntimeActionRecord['reason'];
    executeAfter: string;
    createdAt: string;
  },
): Promise<BillingRuntimeActionRecord | undefined> {
  await db.ready;
  const id = randomUUID();
  const result = await sql<BillingRuntimeActionRow>`
    INSERT INTO billing_runtime_actions (
      id, machine_id, stripe_subscription_id, action, reason, status,
      execute_after, attempts, created_at, updated_at
    )
    SELECT
      ${id}, machine.machine_id, ${input.stripeSubscriptionId}, ${input.action},
      ${input.reason}, 'queued', ${input.executeAfter}, 0, ${input.createdAt}, ${input.createdAt}
    FROM (
      SELECT machine_id
      FROM user_machines
      WHERE clerk_user_id = ${input.clerkUserId}
        AND runtime_slot = ${input.runtimeSlot}
        AND provisioning_class = 'customer'
        AND deleted_at IS NULL
      ORDER BY provisioned_at DESC
      LIMIT 1
    ) AS machine
    ON CONFLICT (machine_id, action) WHERE status IN ('queued', 'running')
    DO UPDATE SET
      execute_after = LEAST(billing_runtime_actions.execute_after, EXCLUDED.execute_after),
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      reason = EXCLUDED.reason,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `.execute(db.executor);
  const row = result.rows[0];
  return row ? mapBillingRuntimeAction(row) : undefined;
}

export async function cancelQueuedBillingRuntimeActions(
  db: PlatformDB,
  stripeSubscriptionId: string,
  action: BillingRuntimeAction,
  canceledAt: string,
): Promise<number> {
  await db.ready;
  const rows = await db.executor
    .updateTable('billing_runtime_actions')
    .set({ status: 'canceled', updated_at: canceledAt, completed_at: canceledAt })
    .where('stripe_subscription_id', '=', stripeSubscriptionId)
    .where('action', '=', action)
    .where('status', '=', 'queued')
    .returning('id')
    .execute();
  return rows.length;
}

export async function listBillingRuntimeActions(
  db: PlatformDB,
  stripeSubscriptionId: string,
): Promise<BillingRuntimeActionRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('billing_runtime_actions')
    .selectAll()
    .where('stripe_subscription_id', '=', stripeSubscriptionId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(mapBillingRuntimeAction);
}

export async function listDispatchableBillingRuntimeActions(
  db: PlatformDB,
  nowIso: string,
  limit: number,
): Promise<BillingRuntimeActionRecord[]> {
  await db.ready;
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await db.executor
    .selectFrom('billing_runtime_actions')
    .selectAll()
    .where((eb) => eb.or([
      eb.and([eb('status', '=', 'queued'), eb('execute_after', '<=', nowIso)]),
      eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', nowIso)]),
    ]))
    .where((eb) => eb.or([
      eb('action', '!=', 'resume'),
      eb.not(eb.exists(
        eb.selectFrom('billing_runtime_actions as blocker')
          .select('blocker.id')
          .whereRef('blocker.machine_id', '=', 'billing_runtime_actions.machine_id')
          .where('blocker.action', '=', 'suspend')
          .where('blocker.status', 'in', ['queued', 'running']),
      )),
    ]))
    .orderBy('execute_after', 'asc')
    .limit(boundedLimit)
    .execute();
  return rows.map(mapBillingRuntimeAction);
}

export async function claimBillingRuntimeAction(
  db: PlatformDB,
  id: string,
  nowIso: string,
  leaseExpiresAt: string,
  maxAttempts: number,
): Promise<BillingRuntimeActionRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('billing_runtime_actions')
    .set((eb) => ({
      status: 'running',
      attempts: eb('attempts', '+', 1),
      claimed_at: nowIso,
      lease_expires_at: leaseExpiresAt,
      updated_at: nowIso,
    }))
    .where('id', '=', id)
    .where('attempts', '<', maxAttempts)
    .where((eb) => eb.or([
      eb.and([eb('status', '=', 'queued'), eb('execute_after', '<=', nowIso)]),
      eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', nowIso)]),
    ]))
    .returningAll()
    .executeTakeFirst();
  return row ? mapBillingRuntimeAction(row) : undefined;
}

export async function completeBillingRuntimeAction(
  db: PlatformDB,
  id: string,
  completedAt: string,
): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .updateTable('billing_runtime_actions')
    .set({
      status: 'completed', lease_expires_at: null, last_error_code: null,
      updated_at: completedAt, completed_at: completedAt,
    })
    .where('id', '=', id)
    .where('status', '=', 'running')
    .returning('id')
    .executeTakeFirst();
  return Boolean(row);
}

export async function retryBillingRuntimeAction(
  db: PlatformDB,
  input: {
    id: string;
    nowIso: string;
    nextExecuteAfter: string;
    errorCode: string;
    exhausted: boolean;
  },
): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .updateTable('billing_runtime_actions')
    .set({
      status: input.exhausted ? 'failed' : 'queued',
      execute_after: input.nextExecuteAfter,
      lease_expires_at: null,
      last_error_code: input.errorCode.slice(0, 64),
      updated_at: input.nowIso,
      completed_at: input.exhausted ? input.nowIso : null,
    })
    .where('id', '=', input.id)
    .where('status', '=', 'running')
    .returning('id')
    .executeTakeFirst();
  return Boolean(row);
}
