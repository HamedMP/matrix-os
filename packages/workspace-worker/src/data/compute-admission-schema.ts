import { sql, type Kysely } from 'kysely';
import type { ComputeBudgetDatabase } from './compute-budget.js';
import type { WorkspaceDatabase } from './repository.js';

export interface AdmissionDatabase {
  shared_compute_accounts: { owner_id: string; period_id: string; state: 'active' | 'suspended' | 'deleted' };
  shared_compute_outbox: {
    owner_id: string; job_id: string; period_id: string; amount_ms: number;
    fingerprint: Record<string, unknown>; payload: Record<string, unknown>;
    state: 'pending' | 'running' | 'completed' | 'cancelled' | 'uncertain';
    queued_at: number; expires_at: number; delivery_at: number | null; enqueued_at: number | null;
    started_at: number | null; generation: number | null; reconcile_at: number;
  };
}
export type AdmissionData = WorkspaceDatabase & ComputeBudgetDatabase & AdmissionDatabase;
export async function initializeComputeAdmission(db: Kysely<AdmissionData>): Promise<void> {
  await db.schema.createTable('shared_compute_accounts').ifNotExists()
    .addColumn('owner_id', 'text', (c) => c.primaryKey())
    .addColumn('period_id', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addForeignKeyConstraint('shared_compute_account_workspace', ['owner_id'], 'shared_workspaces', ['owner_id'])
    .addForeignKeyConstraint('shared_compute_account_policy', ['owner_id', 'period_id'], 'shared_compute_policies', ['owner_id', 'period_id'])
    .addCheckConstraint('shared_compute_account_state', sql`state in ('active','suspended','deleted')`).execute();
  await db.schema.createTable('shared_compute_outbox').ifNotExists()
    .addColumn('owner_id', 'text', (c) => c.notNull()).addColumn('job_id', 'text', (c) => c.notNull())
    .addColumn('period_id', 'text', (c) => c.notNull()).addColumn('amount_ms', 'double precision', (c) => c.notNull())
    .addColumn('fingerprint', 'jsonb', (c) => c.notNull()).addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull()).addColumn('queued_at', 'double precision', (c) => c.notNull())
    .addColumn('expires_at', 'double precision', (c) => c.notNull()).addColumn('delivery_at', 'double precision')
    .addColumn('enqueued_at', 'double precision').addColumn('started_at', 'double precision')
    .addColumn('generation', 'integer').addColumn('reconcile_at', 'double precision', (c) => c.notNull())
    .addPrimaryKeyConstraint('shared_compute_outbox_owner_job', ['owner_id', 'job_id'])
    .addForeignKeyConstraint('shared_compute_outbox_reservation', ['owner_id', 'job_id'], 'shared_compute_reservations', ['owner_id', 'reservation_id'])
    .addCheckConstraint('shared_compute_outbox_state', sql`state in ('pending','running','completed','cancelled','uncertain')`)
    .addCheckConstraint('shared_compute_outbox_window', sql`queued_at >= 0 and expires_at > queued_at and expires_at - queued_at <= 900000 and amount_ms between 1 and 1800000`)
    .addCheckConstraint('shared_compute_outbox_claim', sql`(started_at is null and generation is null and state in ('pending','cancelled')) or (started_at is not null and generation > 0 and state in ('running','completed','uncertain'))`).execute();
  await db.schema.createIndex('shared_compute_outbox_dispatch').ifNotExists().on('shared_compute_outbox').columns(['state', 'delivery_at', 'queued_at']).execute();
  await db.schema.createIndex('shared_compute_outbox_reconcile').ifNotExists().on('shared_compute_outbox').columns(['state', 'reconcile_at']).execute();
}
