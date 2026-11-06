import { sql, type Kysely } from 'kysely';
import { runPlatformMigration } from '../migration-runner.js';
export const OPERATOR_PROBE_BUDGET_SCOPE = 'operator-probe-budget';
export const OPERATOR_PROBE_BUDGET_REVISION = { generation: 2, fingerprint: 'operator-probe-instance-binding-v2' };
export async function migrateOperatorProbeBudget<DB>(db: Kysely<DB>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS operator_probe_wallets (
    budget_id TEXT PRIMARY KEY, config JSONB NOT NULL, config_hash TEXT NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
    held_microusd BIGINT NOT NULL DEFAULT 0 CHECK (held_microusd >= 0),
    settled_microusd BIGINT NOT NULL DEFAULT 0 CHECK (settled_microusd >= 0),
    frozen BOOLEAN NOT NULL DEFAULT false, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10000),
    CHECK (held_microusd + settled_microusd + (config->>'historicalReserveMicrousd')::bigint <= (config->>'allocationMicrousd')::bigint)
  )`.execute(db);
  // Volatile per-row default backfills existing wallets exactly once; financial rows are untouched.
  await sql`ALTER TABLE operator_probe_wallets ADD COLUMN IF NOT EXISTS instance_nonce UUID NOT NULL DEFAULT gen_random_uuid()`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION protect_operator_probe_instance() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.instance_nonce IS DISTINCT FROM OLD.instance_nonce THEN RAISE EXCEPTION 'Immutable operator wallet instance'; END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`DROP TRIGGER IF EXISTS operator_probe_instance_immutable ON operator_probe_wallets`.execute(db);
  await sql`CREATE TRIGGER operator_probe_instance_immutable BEFORE UPDATE OF instance_nonce ON operator_probe_wallets
    FOR EACH ROW EXECUTE FUNCTION protect_operator_probe_instance()`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS operator_probe_attempts (
    budget_id TEXT NOT NULL REFERENCES operator_probe_wallets(budget_id), probe_id UUID NOT NULL,
    attempt JSONB NOT NULL, PRIMARY KEY (budget_id, probe_id)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS operator_probe_receipts (
    budget_id TEXT NOT NULL, probe_id UUID NOT NULL, payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    receipt JSONB NOT NULL, PRIMARY KEY (budget_id, probe_id, payload_hash),
    FOREIGN KEY (budget_id, probe_id) REFERENCES operator_probe_attempts(budget_id, probe_id)
  )`.execute(db);
}
export function runOperatorProbeBudgetMigrations<DB>(db: Kysely<DB>): Promise<void> {
  return runPlatformMigration(db, migrateOperatorProbeBudget, { scope: OPERATOR_PROBE_BUDGET_SCOPE, revision: OPERATOR_PROBE_BUDGET_REVISION });
}
