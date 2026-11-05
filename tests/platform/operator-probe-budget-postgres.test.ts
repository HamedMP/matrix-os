import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { startOperatorProbeAuthority } from '../../packages/platform/src/operator-probe-budget/main.js';
import { sql, type Kysely } from 'kysely';
import type { PlatformDatabase } from '../../packages/platform/src/db.js';
import { PLATFORM_SCHEMA_REVISION } from '../../packages/platform/src/database/migration-revision.js';
import { runPlatformStartupMigrations } from '../../packages/platform/src/database/run-migrations.js';
import { createOperatorProbeBudgetRepository, initializeOperatorProbeBudget } from '../../packages/platform/src/operator-probe-budget/repository.js';
import { runOperatorProbeBudgetMigrations } from '../../packages/platform/src/operator-probe-budget/migration.js';
import { beginInput, config, policy, postgresFixture, usage } from './operator-probe-budget-fixture.js';
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('lifetime operator wallet with independent real PostgreSQL pools', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let db: ReturnType<typeof fixture.connect>;
  let clock: Date;
  function store(connection = db) { return createOperatorProbeBudgetRepository({ db: connection, budgetId: config.budgetId, now: () => clock }); }
  beforeEach(async () => { fixture = await postgresFixture(); db = fixture.connect(); clock = new Date('2026-11-06T23:59:59Z'); await runOperatorProbeBudgetMigrations(db); });
  afterEach(async () => { await fixture?.destroy(); });
  async function seed() { await initializeOperatorProbeBudget(db, config); }
  async function started() { await seed(); const input = beginInput(); const result = await store().begin(input); return { input, attempt: result.attempt }; }
  function finalize(attempt: Awaited<ReturnType<typeof started>>['attempt']) { return { protocolVersion: 1 as const,
    probeId: attempt.probeId, executionId: attempt.executionId, economicHash: attempt.economicHash,
    outcome: 'ready' as const, usage, providerReferenceHash: 'b'.repeat(64) }; }
  async function authority() {
    const portProbe = createServer();
    await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic port unavailable');
    await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
    const service = await startOperatorProbeAuthority({
      MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_DATABASE_URL: fixture.databaseUrl,
      MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN: 's'.repeat(32),
      MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID: 'synthetic',
      MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_PORT: String(address.port),
    });
    return { ...service, port: address.port };
  }
  it('fails closed without an explicitly initialized wallet and never seeds at startup', async () => {
    await expect(store().begin(beginInput())).rejects.toThrow(); expect(await store().getStatus()).toBeNull();
  });
  it('serializes independent-pool competing holds without overspending', async () => {
    await seed(); const other = store(fixture.connect());
    const results = await Promise.allSettled([store().begin(beginInput()), other.begin(beginInput())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: policy.maximumCostMicrousd, settledMicrousd: 0 });
  });
  it('grants exactly once despite concurrent replay or changed execution IDs', async () => {
    await seed(); const input = beginInput(); const other = store(fixture.connect());
    const results = await Promise.all([store().begin(input), other.begin({ ...input, executionId: randomUUID() })]);
    expect(results.filter(r => r.dispatchGranted)).toHaveLength(1);
    expect(results[0].attempt.executionId).toBe(results[1].attempt.executionId);
    await expect(store().begin({ ...input, policy: { ...policy, requestFingerprint: 'c'.repeat(64) } })).rejects.toThrow();
  });
  it('preserves crash liability across startup replay, UTC rollover and reconnect', async () => {
    const { input } = await started(); clock = new Date('2026-11-07T00:00:01Z');
    await runOperatorProbeBudgetMigrations(fixture.connect()); await seed();
    expect((await store(fixture.connect()).begin(input)).dispatchGranted).toBe(false);
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: policy.maximumCostMicrousd, historicalUnpriced: true, historicalReserveMicrousd: 1_000_000 });
    await expect(initializeOperatorProbeBudget(db, { ...config, allocationMicrousd: 7_000_000 })).rejects.toThrow();
  });
  it('settles known negative health, exact replay and immutable old prices after expiry', async () => {
    const { attempt } = await started(); clock = new Date('2026-12-01T00:00:00Z');
    const payload = { ...finalize(attempt), outcome: 'not_ready' as const };
    const receipt = await store().finalize(payload);
    expect(receipt).toMatchObject({ status: 'settled', costMicrousd: 25, outcome: 'not_ready' });
    expect(await store(fixture.connect()).finalize(payload)).toEqual(receipt);
    await expect(store().finalize({ ...payload, usage: { ...usage, inputTokens: 5 } })).rejects.toThrow();
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: 0, settledMicrousd: 25 });
    await expect(store().begin(beginInput())).rejects.toThrow();
  });
  it('retains unknown cost indefinitely, then reconciles only a matching attributable execution', async () => {
    const { attempt } = await started(); const payload = { ...finalize(attempt), outcome: 'unknown' as const, usage: null };
    expect(await store().finalize(payload)).toMatchObject({ status: 'unknown', costMicrousd: null });
    expect(await store().finalize(payload)).toEqual(await store().finalize(payload));
    clock = new Date('2027-01-01T00:00:00Z');
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: policy.maximumCostMicrousd });
    await expect(store().finalize({ ...finalize(attempt), executionId: randomUUID() })).rejects.toThrow();
    expect(await store().finalize(finalize(attempt))).toMatchObject({ status: 'settled', costMicrousd: 25 });
    expect(await store().finalize(payload)).toMatchObject({ status: 'unknown' });
    expect((await store().getAttempt(attempt.probeId))?.status).toBe('settled');
  });
  it('retains explicit unknown with valid counts until late terminal attribution and preserves bounded receipt history', async () => {
    const { attempt } = await started();
    const unknown = { ...finalize(attempt), outcome: 'unknown' as const };
    const receipt = await store().finalize(unknown);
    expect(receipt).toMatchObject({ status: 'unknown', costMicrousd: null });
    expect(await store(fixture.connect()).getStatus()).toMatchObject({ heldMicrousd: policy.maximumCostMicrousd, settledMicrousd: 0 });
    await expect(store().begin(beginInput())).rejects.toThrow();
    await expect(store().finalize({ ...unknown, usage: { ...usage, inputTokens: 5 } })).rejects.toThrow();
    await expect(store().finalize({ ...unknown, usage: null })).rejects.toThrow();
    clock = new Date('2027-01-01T00:00:00Z');
    expect(await store().finalize(finalize(attempt))).toMatchObject({ status: 'settled', costMicrousd: 25 });
    expect(await store(fixture.connect()).getStatus()).toMatchObject({ heldMicrousd: 0, settledMicrousd: 25 });
    expect(await store().finalize(unknown)).toEqual(receipt);
    expect((await store().getAttempt(attempt.probeId))?.status).toBe('settled');
    const count = await sql<{ count: string }>`SELECT count(*) AS count FROM operator_probe_receipts`.execute(db);
    expect(Number(count.rows[0].count)).toBe(2);
  });
  it('prioritizes a discrepancy over changed unknown reports and keeps only bounded immutable history', async () => {
    const { attempt } = await started();
    const unknown = { ...finalize(attempt), outcome: 'unknown' as const };
    const original = await store().finalize(unknown);
    expect(await store().finalize({ ...unknown, usage: { ...usage, inputTokens: 10_000_001 } })).toMatchObject({ status: 'discrepancy' });
    expect(await store().getStatus()).toMatchObject({ frozen: true, heldMicrousd: policy.maximumCostMicrousd, settledMicrousd: 0 });
    expect(await store().finalize(unknown)).toEqual(original);
    await expect(store().finalize(finalize(attempt))).rejects.toThrow();
    const count = await sql<{ count: string }>`SELECT count(*) AS count FROM operator_probe_receipts`.execute(db);
    expect(Number(count.rows[0].count)).toBe(2);
  });
  it.each(['inputTokens', 'outputTokens', 'cacheReadTokens'] as const)('freezes an authenticated HTTP %s overrun above admission bounds, even with unknown outcome', async bucket => {
    const { attempt } = await started();
    const service = await authority();
    const origin = `http://127.0.0.1:${service.port}/ai/operator-probe-budget`;
    const headers = { authorization: `Bearer ${'s'.repeat(32)}` };
    try {
      for (const invalid of [-1, 1.5, '10000001']) {
        const rejected = await fetch(`${origin}/finalize`, { method: 'POST', headers,
          body: JSON.stringify({ ...finalize(attempt), usage: { ...usage, [bucket]: invalid } }), signal: AbortSignal.timeout(5000), redirect: 'error' });
        expect(rejected.status).toBe(400);
      }
      expect(await store().getStatus()).toMatchObject({ frozen: false, heldMicrousd: policy.maximumCostMicrousd });
      const response = await fetch(`${origin}/finalize`, { method: 'POST', headers,
        body: JSON.stringify({ ...finalize(attempt), outcome: 'unknown', usage: { ...usage, [bucket]: bucket === 'inputTokens' ? 10_000_001 : Number.MAX_SAFE_INTEGER } }),
        signal: AbortSignal.timeout(5000), redirect: 'error' });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'discrepancy' });
      expect((await store().getAttempt(attempt.probeId))?.status).toBe('discrepancy');
      expect(await store().getStatus()).toMatchObject({ frozen: true, heldMicrousd: policy.maximumCostMicrousd, settledMicrousd: 0 });
      const next = await fetch(`${origin}/begin`, { method: 'POST', headers, body: JSON.stringify(beginInput()), signal: AbortSignal.timeout(5000), redirect: 'error' });
      expect(next.status).toBe(503);
    } finally { await service.close(); }
  });
  it('freezes admission and retains discrepancies for over-bound attributable usage', async () => {
    const { attempt } = await started();
    expect(await store().finalize({ ...finalize(attempt), usage: { ...usage, outputTokens: 2 } })).toMatchObject({ status: 'discrepancy' });
    expect(await store().getStatus()).toMatchObject({ frozen: true, heldMicrousd: policy.maximumCostMicrousd });
    await expect(store().begin(beginInput())).rejects.toThrow();
  });
  it('rejects expired policy or disabled budget before creating an attempt', async () => {
    await initializeOperatorProbeBudget(db, { ...config, expiresAt: '2026-12-30T00:00:00Z' });
    const input = beginInput();
    clock = new Date('2026-11-26T00:00:00Z'); await expect(store().begin(input)).rejects.toThrow();
    expect(await store().getAttempt(input.probeId)).toBeNull();
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: 0, attemptCount: 0 });
  });
  it('rolls back hold changes when attempt insertion fails', async () => {
    await seed();
    await sql`CREATE FUNCTION reject_probe_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`.execute(db);
    await sql`CREATE TRIGGER reject_probe BEFORE INSERT ON operator_probe_attempts FOR EACH ROW EXECUTE FUNCTION reject_probe_insert()`.execute(db);
    await expect(store().begin(beginInput())).rejects.toThrow();
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: 0, attemptCount: 0 });
  });
  it('keeps missing or malformed usage held, and never accepts a changed unresolved replay', async () => {
    const { attempt } = await started();
    await expect(store().finalize({ ...finalize(attempt), usage: { ...usage, inputTokens: -1 } })).rejects.toThrow();
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: policy.maximumCostMicrousd });
    expect(await store().finalize({ ...finalize(attempt), usage: null })).toMatchObject({ status: 'unknown', costMicrousd: null });
    await expect(store().finalize({ ...finalize(attempt), usage: null, outcome: 'unknown' })).rejects.toThrow();
  });
  it('freezes on aggregate normalized input/cache overrun without releasing held money', async () => {
    const { attempt } = await started();
    expect(await store().finalize({ ...finalize(attempt), usage: { ...usage, inputTokens: 999_999, cacheReadTokens: 5 } })).toMatchObject({ status: 'discrepancy' });
    expect(await store().getStatus()).toMatchObject({ frozen: true, heldMicrousd: policy.maximumCostMicrousd });
  });
  it('rolls back settlement when receipt persistence fails, preserving a recoverable hold', async () => {
    const { attempt } = await started();
    await sql`CREATE FUNCTION reject_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`.execute(db);
    await sql`CREATE TRIGGER reject_receipt BEFORE INSERT ON operator_probe_receipts FOR EACH ROW EXECUTE FUNCTION reject_receipt_insert()`.execute(db);
    await expect(store().finalize(finalize(attempt))).rejects.toThrow();
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: policy.maximumCostMicrousd, settledMicrousd: 0 });
    expect((await store().getAttempt(attempt.probeId))?.status).toBe('started');
    await sql`DROP TRIGGER reject_receipt ON operator_probe_receipts`.execute(db);
    expect(await store().finalize(finalize(attempt))).toMatchObject({ status: 'settled' });
  });
  it('caps lifetime attempts under the wallet lock and rejects disabled allocation', async () => {
    await initializeOperatorProbeBudget(db, { ...config, enabled: false });
    await expect(store().begin(beginInput())).rejects.toThrow();
    // Separate synthetic wallet: no production reconfiguration endpoint exists.
    const capPolicy = { ...policy, maximumInputTokens: 1, maximumCostMicrousd: 17 };
    const capConfig = { ...config, budgetId: 'cap-test', policies: [capPolicy] };
    await initializeOperatorProbeBudget(db, capConfig);
    await sql`UPDATE operator_probe_wallets SET attempt_count=9999 WHERE budget_id='cap-test'`.execute(db);
    const capped = createOperatorProbeBudgetRepository({ db, budgetId: 'cap-test', now: () => clock });
    const other = createOperatorProbeBudgetRepository({ db: fixture.connect(), budgetId: 'cap-test', now: () => clock });
    const results = await Promise.allSettled([capped.begin({ ...beginInput(), policy: capPolicy }), other.begin({ ...beginInput(), policy: capPolicy })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(capped.begin({ ...beginInput(), policy: capPolicy })).rejects.toThrow();
    expect(await capped.getStatus()).toMatchObject({ attemptCount: 10000, heldMicrousd: 17 });
  });
  it('serializes concurrent duplicate finalization and preserves one immutable receipt', async () => {
    const { attempt } = await started(); const other = store(fixture.connect());
    const receipts = await Promise.all([store().finalize(finalize(attempt)), other.finalize(finalize(attempt))]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: 0, settledMicrousd: 25 });
  });
  it('settles normalized Workers usage at its immutable reviewed snapshot', async () => {
    const glm = { ...policy, canonicalModelId: '@cf/zai-org/glm-5.3-flash', nativeModelId: '@cf/zai-org/glm-5.3-flash',
      pricingVersion: 'cloudflare-2026-09-10-glm-flash', maximumInputTokens: 1_310_720,
      inputRateThousandths: 150, outputRateThousandths: 500, cacheReadRateThousandths: 30,
      cacheWrite5mRateThousandths: 150, cacheWrite1hRateThousandths: 150, maximumCostMicrousd: 235_931 };
    await initializeOperatorProbeBudget(db, { ...config, policies: [glm] });
    const result = await store().begin({ ...beginInput(), policy: glm });
    expect(result.dispatchGranted).toBe(true);
    expect(await store().finalize({ ...finalize(result.attempt), usage: { inputTokens: 100, outputTokens: 1,
      cacheReadTokens: 20, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 } })).toMatchObject({ status: 'settled', costMicrousd: 17 });
    expect(await store().getStatus()).toMatchObject({ heldMicrousd: 0, settledMicrousd: 17 });
  });
  it('starts only the standalone additive authority without seeding money and drains its owned server', async () => {
    const service = await authority();
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}/ai/operator-probe-budget/status`, {
        headers: { authorization: `Bearer ${'s'.repeat(32)}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
      expect(response.status).toBe(200); expect(await response.json()).toBeNull();
      const scopes = await sql<{ scope: string }>`SELECT scope FROM platform_schema_revisions`.execute(db);
      expect(scopes.rows.map(row => row.scope)).toEqual(['operator-probe-budget']);
    } finally { await service.close(); await service.close(); }
  });
  it('uses an independent additive scope with both old and newer core schema markers', async () => {
    await runPlatformStartupMigrations(db as unknown as Kysely<PlatformDatabase>);
    for (const generation of [1, 99999]) {
      await sql`DROP TABLE operator_probe_receipts, operator_probe_attempts, operator_probe_wallets`.execute(db);
      await sql`DELETE FROM platform_schema_revisions WHERE scope='operator-probe-budget'`.execute(db);
      await sql`INSERT INTO platform_schema_revisions(scope,generation,fingerprint) VALUES ('core',${generation},'synthetic') ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation`.execute(db);
      await runPlatformStartupMigrations(fixture.connect() as unknown as Kysely<PlatformDatabase>);
      const tables = await sql<{ table: string | null }>`SELECT to_regclass('operator_probe_wallets')::text AS table`.execute(db);
      expect(tables.rows[0].table).toBe('operator_probe_wallets');
      expect((await sql<{ generation: number }>`SELECT generation FROM platform_schema_revisions WHERE scope='core'`.execute(db)).rows[0].generation).toBe(Math.max(generation, PLATFORM_SCHEMA_REVISION.generation));
    }
    await seed(); expect((await store().begin(beginInput())).dispatchGranted).toBe(true);
  });
});
