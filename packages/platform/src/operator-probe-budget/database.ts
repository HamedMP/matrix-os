import { Kysely, PostgresDialect, type JSONColumnType } from 'kysely';
import { createPostgresPool } from '../database/postgres-connections.js';
import type { OperatorProbeAttempt, OperatorProbeBudgetConfig, OperatorProbeReceipt } from '@matrix-os/contracts/funded-operator-probe';
export type OperatorProbeDatabase = {
  operator_probe_wallets: { budget_id: string; config: JSONColumnType<OperatorProbeBudgetConfig>;
    config_hash: string; held_microusd: string; settled_microusd: string; frozen: boolean; attempt_count: number };
  operator_probe_attempts: { budget_id: string; probe_id: string; attempt: JSONColumnType<OperatorProbeAttempt> };
  operator_probe_receipts: { budget_id: string; probe_id: string; payload_hash: string; receipt: JSONColumnType<OperatorProbeReceipt> };
};
/** This factory owns its pool. Injected repository databases never close it. */
export function createOperatorProbeBudgetDatabase(connectionString: string): Kysely<OperatorProbeDatabase> {
  return new Kysely({ dialect: new PostgresDialect({ pool: createPostgresPool({ connectionString, max: 8,
    connectionTimeoutMillis: 5000, statement_timeout: 10000, lock_timeout: 5000 }, 'operator-probe-budget') }) });
}
