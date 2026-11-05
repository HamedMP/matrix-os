import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { OperatorProbeDatabase } from '../../packages/platform/src/operator-probe-budget/database.js';
export const policy = {
  canonicalModelId: 'anthropic/claude-sonnet-5', nativeModelId: 'claude-sonnet-5',
  pricingVersion: 'synthetic-reviewed-v1', pricingValidThrough: '2026-11-25T00:00:00.000Z',
  requestFingerprint: 'a'.repeat(64), maximumInputTokens: 1_000_000, maximumOutputTokens: 1 as const,
  inputRateThousandths: 2000, outputRateThousandths: 10000, cacheReadRateThousandths: 200,
  cacheWrite5mRateThousandths: 2500, cacheWrite1hRateThousandths: 4000, maximumCostMicrousd: 4_800_012,
};
export const config = { budgetId: 'synthetic', allocationMicrousd: 6_250_000,
  historicalReserveMicrousd: 1_000_000, historicalUnpriced: true as const,
  enabled: true, expiresAt: '2026-11-25T00:00:00.000Z', revision: 'review-v1', source: 'synthetic-test', policies: [policy] };
export const usage = { inputTokens: 4, outputTokens: 1, cacheReadTokens: 2, cacheWrite5mTokens: 1, cacheWrite1hTokens: 1 };
export function beginInput() { return { protocolVersion: 1 as const, probeId: randomUUID(), executionId: randomUUID(), policy }; }
export async function postgresFixture() {
  const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
  if (!connectionString || !new URL(connectionString).pathname.includes('test')) throw new Error('Dedicated synthetic PostgreSQL test fixture required');
  const schema = `operator_probe_${randomUUID().replaceAll('-', '')}`;
  const admin = new Kysely<OperatorProbeDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  const databases: Kysely<OperatorProbeDatabase>[] = [];
  function connect() {
    const db = new Kysely<OperatorProbeDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 2,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=3000` }) }) });
    databases.push(db); return db;
  }
  const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`);
  return { connect, databaseUrl: url.toString(), async destroy() {
    await Promise.all(databases.map(db => db.destroy()));
    try { await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); } finally { await admin.destroy(); }
  } };
}
