import { sql, type Kysely } from 'kysely';
import { runPlatformMigration } from '../migration-runner.js';
export const OPERATOR_PROBE_BUDGET_SCOPE = 'operator-probe-budget';
export const OPERATOR_PROBE_BUDGET_REVISION = { generation: 1, fingerprint: 'operator-probe-lifetime-wallet-v1' };
export async function migrateOperatorProbeBudget<DB>(db: Kysely<DB>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS operator_probe_wallets (
    budget_id TEXT PRIMARY KEY, config JSONB NOT NULL, config_hash TEXT NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
    held_microusd BIGINT NOT NULL DEFAULT 0 CHECK (held_microusd >= 0),
    settled_microusd BIGINT NOT NULL DEFAULT 0 CHECK (settled_microusd >= 0),
    frozen BOOLEAN NOT NULL DEFAULT false, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10000),
    CHECK (held_microusd + settled_microusd + (config->>'historicalReserveMicrousd')::bigint <= (config->>'allocationMicrousd')::bigint)
  )`.execute(db);
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
