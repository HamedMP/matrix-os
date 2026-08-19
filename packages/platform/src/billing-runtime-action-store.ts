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
  reason: 'trial_payment_failed' | 'trial_ended_unpaid' | 'payment_recovered' | 'billing_recovered';
  status: BillingRuntimeActionStatus;
  executeAfter: string;
  attempts: number;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
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
  cancel_requested_at: string | null;
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
    cancelRequestedAt: row.cancel_requested_at,
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
      cancel_requested_at = NULL,
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

export interface CanceledBillingRuntimeActionCounts {
  queued: number;
  running: number;
}

export async function cancelOutstandingBillingRuntimeActions(
  db: PlatformDB,
  stripeSubscriptionId: string,
  action: BillingRuntimeAction,
  canceledAt: string,
): Promise<CanceledBillingRuntimeActionCounts> {
  await db.ready;
  const result = await sql<{ previous_status: 'queued' | 'running' }>`
    WITH targets AS MATERIALIZED (
      SELECT id, status AS previous_status
      FROM billing_runtime_actions
      WHERE stripe_subscription_id = ${stripeSubscriptionId}
        AND action = ${action}
        AND status IN ('queued', 'running')
      FOR UPDATE
    ), canceled AS (
      UPDATE billing_runtime_actions AS pending
      SET
        status = CASE
          WHEN targets.previous_status = 'queued' THEN 'canceled'
          ELSE pending.status
        END,
        cancel_requested_at = CASE
          WHEN targets.previous_status = 'running' THEN ${canceledAt}
          ELSE pending.cancel_requested_at
        END,
        updated_at = ${canceledAt},
        completed_at = CASE
          WHEN targets.previous_status = 'queued' THEN ${canceledAt}
          ELSE pending.completed_at
        END
      FROM targets
      WHERE pending.id = targets.id
      RETURNING targets.previous_status
    )
    SELECT previous_status FROM canceled
  `.execute(db.executor);
  return result.rows.reduce<CanceledBillingRuntimeActionCounts>((counts, row) => ({
    ...counts,
    [row.previous_status]: counts[row.previous_status] + 1,
  }), { queued: 0, running: 0 });
}

export async function isBillingRuntimeActionRunnable(
  db: PlatformDB,
  id: string,
): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_runtime_actions')
    .select('id')
    .where('id', '=', id)
    .where('status', '=', 'running')
    .where('cancel_requested_at', 'is', null)
    .executeTakeFirst();
  return Boolean(row);
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
  return listDispatchableBillingRuntimeActionsInternal(db, nowIso, limit);
}

export async function listDispatchableBillingRuntimeActionsForMachine(
  db: PlatformDB,
  machineId: string,
  nowIso: string,
  limit: number,
): Promise<BillingRuntimeActionRecord[]> {
  return listDispatchableBillingRuntimeActionsInternal(db, nowIso, limit, machineId);
}

async function listDispatchableBillingRuntimeActionsInternal(
  db: PlatformDB,
  nowIso: string,
  limit: number,
  machineId?: string,
): Promise<BillingRuntimeActionRecord[]> {
  await db.ready;
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  await db.executor
    .updateTable('billing_runtime_actions')
    .set({ status: 'canceled', updated_at: nowIso, completed_at: nowIso, lease_expires_at: null })
    .where('status', '=', 'running')
    .where('cancel_requested_at', 'is not', null)
    .where('lease_expires_at', '<=', nowIso)
    .$if(machineId !== undefined, (query) => query.where('machine_id', '=', machineId ?? ''))
    .execute();
  const rows = await db.executor
    .selectFrom('billing_runtime_actions')
    .selectAll()
    .where((eb) => eb.or([
      eb.and([eb('status', '=', 'queued'), eb('execute_after', '<=', nowIso)]),
      eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', nowIso)]),
    ]))
    .where('cancel_requested_at', 'is', null)
    .$if(machineId !== undefined, (query) => query.where('machine_id', '=', machineId ?? ''))
    .where((eb) => eb.not(eb.exists(
      eb.selectFrom('billing_runtime_actions as in_flight_opposite')
        .select('in_flight_opposite.id')
        .whereRef('in_flight_opposite.machine_id', '=', 'billing_runtime_actions.machine_id')
        .whereRef('in_flight_opposite.action', '!=', 'billing_runtime_actions.action')
        .where('in_flight_opposite.status', '=', 'running'),
    )))
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
    .where('cancel_requested_at', 'is', null)
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
  return (await finalizeBillingRuntimeAction(db, id, completedAt)) === 'completed';
}

export type BillingRuntimeActionFinalStatus = 'completed' | 'canceled';

export async function finalizeBillingRuntimeAction(
  db: PlatformDB,
  id: string,
  completedAt: string,
): Promise<BillingRuntimeActionFinalStatus | undefined> {
  await db.ready;
  const result = await sql<{ status: BillingRuntimeActionFinalStatus }>`
    UPDATE billing_runtime_actions
    SET
      status = CASE
        WHEN cancel_requested_at IS NULL THEN 'completed'
        ELSE 'canceled'
      END,
      lease_expires_at = NULL,
      last_error_code = NULL,
      updated_at = ${completedAt},
      completed_at = ${completedAt}
    WHERE id = ${id}
      AND status = 'running'
    RETURNING status
  `.execute(db.executor);
  return result.rows[0]?.status;
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
    .where('cancel_requested_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return Boolean(row);
}
