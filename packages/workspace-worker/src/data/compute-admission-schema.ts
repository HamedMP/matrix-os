import { sql, type Kysely } from 'kysely';
import type { ComputeBudgetDatabase } from './compute-budget.js';
import type { WorkspaceDatabase } from './repository.js';

export interface AdmissionDatabase {
  shared_compute_accounts: { owner_id: string; period_id: string; state: 'active' | 'suspended' | 'deleted' };
  shared_compute_outbox: {
    owner_id: string; job_id: string; period_id: string; amount_ms: number;
    fingerprint: Record<string, unknown>; payload: Record<string, unknown>;
    state: 'pending' | 'running' | 'completed' | 'interrupted' | 'cancelled' | 'uncertain';
    queued_at: number; expires_at: number; delivery_at: number | null; enqueued_at: number | null;
    started_at: number | null; generation: number | null; reconcile_at: number;
  };
}
export type AdmissionData = WorkspaceDatabase & ComputeBudgetDatabase & AdmissionDatabase;
const outboxState = sql`state in ('pending','running','completed','interrupted','cancelled','uncertain')`;
const outboxClaim = sql`(started_at is null and generation is null and state in ('pending','cancelled')) or (started_at is not null and generation > 0 and state in ('running','completed','interrupted','uncertain'))`;

/** Existing installations need both checks replaced; do not take a DDL lock on every init. */
async function migrateInterruptedOutcome(db: Kysely<AdmissionData>): Promise<void> {
  const migrated = async (connection: Kysely<AdmissionData>) => {
    const { rows } = await sql<{ count: number }>`select count(*)::integer as count from pg_constraint
      where conrelid = 'shared_compute_outbox'::regclass
        and conname in ('shared_compute_outbox_state','shared_compute_outbox_claim')
        and position('''interrupted''' in pg_get_constraintdef(oid)) > 0`.execute(connection);
    return rows[0].count === 2;
  };
  if (await migrated(db)) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local lock_timeout = '5s'`.execute(trx);
    await sql`set local statement_timeout = '10s'`.execute(trx);
    await sql`lock table shared_compute_outbox in access exclusive mode`.execute(trx);
    // Another initializer may have upgraded it while this connection waited.
    if (await migrated(trx)) return;
    await sql`alter table shared_compute_outbox
      drop constraint shared_compute_outbox_state, drop constraint shared_compute_outbox_claim,
      add constraint shared_compute_outbox_state check (${outboxState}),
      add constraint shared_compute_outbox_claim check (${outboxClaim})`.execute(trx);
  });
}
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
    .addCheckConstraint('shared_compute_outbox_state', outboxState)
    .addCheckConstraint('shared_compute_outbox_window', sql`queued_at >= 0 and expires_at > queued_at and expires_at - queued_at <= 900000 and amount_ms between 1 and 1800000`)
    .addCheckConstraint('shared_compute_outbox_claim', outboxClaim).execute();
  await migrateInterruptedOutcome(db);
  await db.schema.createIndex('shared_compute_outbox_dispatch').ifNotExists().on('shared_compute_outbox').columns(['state', 'delivery_at', 'queued_at']).execute();
  await db.schema.createIndex('shared_compute_outbox_reconcile').ifNotExists().on('shared_compute_outbox').columns(['state', 'reconcile_at']).execute();
}
