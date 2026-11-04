import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { migratePlatformSchema } from '../../packages/platform/src/database/migrate.js';
import { PLATFORM_SCHEMA_REVISION } from '../../packages/platform/src/database/migration-revision.js';
import { runPlatformMigration } from '../../packages/platform/src/migration-runner.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const identity = { ownerId: 'capacity_owner', machineId: 'capacity_machine', runtimeSlot: 'primary' };
const modelId = '@cf/zai-org/glm-5.3-flash';
describe('bounded recovery of repeated failed funded requests', () => {
  let db: PlatformDB;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };
  let now: Date;
  const rows = () => db.executor.selectFrom('ai_funded_usage_reservations').selectAll().orderBy('created_at').execute();
  const finance = async () => ({
    balances: await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute(),
    ledger: await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute(),
    allocations: await db.executor.selectFrom('ai_funded_reservation_promotional_allocations').selectAll().execute(),
  });
  const authorize = (requestId: string, maximum = 100) => repo.authorize({ credential: credential.token,
    requestId, modelId, billingMode: 'usage', maxCostMicrousd: maximum });
  async function start(requestId: string, maximum = 100) {
    const auth = await authorize(requestId, maximum);
    return repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId, executionId: `execution-${requestId}` });
  }
  async function end(started: Awaited<ReturnType<typeof start>>) {
    now = new Date(now.getTime() + 1_000);
    await repo.recordTerminalOutcome({ contractVersion: 1, ...identity, reservationId: started.reservationId,
      tokenId: started.tokenId, requestId: started.requestId, startedAt: started.startedAt, expiresAt: started.expiresAt,
      executionId: started.executionId!, terminalState: 'failed', terminalAt: now.toISOString(), outcome: 'usage_unknown' });
  }
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); now = new Date('2026-10-23T00:00:00.000Z');
    repo = createAiFundedPolicyRepository({ db, now: () => new Date(now), credentialHashSecret: 'h'.repeat(32), credentialTtlMs: 3_600_000, inFlightTtlMs: 60_000 });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'capacity', runtimeSlot: 'primary',
      status: 'running', activationState: 'authorized', imageVersion: 'fixture', provisionedAt: now.toISOString() });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 40_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: 'capacity-credit', identity, kind: 'addon_grant', amountMicrousd: 40_000_000, sourceReference: 'fixture' });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('recovers the third terminal request above the former fifty-cent cap without changing any financial rows', async () => {
    for (const key of ['older-a', 'older-b']) await end(await start(key, 240_845));
    const third = await start('third', 61_133); const before = await finance();
    await end(third);
    expect(await finance()).toEqual(before);
    const saved = await rows();
    expect(saved.map(r => r.execution_recovery_slot)).toEqual([0, 1, 2]);
    expect(saved.every(r => r.execution_admission_release !== null && r.actual_microusd === null && r.status === 'in_flight')).toBe(true);
    await expect(authorize('next')).resolves.toMatchObject({ authorized: true });
  });

  it('recovers beyond one hundred records and reuses gaps without changing financial holds', async () => {
    for (let index = 0; index < 105; index++) await end(await start(`failure-${index}`));
    const saved = await rows();
    expect(saved).toHaveLength(105);
    expect(saved.every(r => r.execution_admission_release !== null)).toBe(true);
    expect(new Set(saved.map(r => r.execution_recovery_slot)).size).toBe(105);
    expect(saved[104].execution_recovery_slot).toBe(104);
    await repo.finalizeReservation({ reservationId: saved[50].reservation_id, tokenId: saved[50].token_id, mode: 'exact', actualCostMicrousd: 10 });
    const next = await start('after-gap'); const before = await finance(); await end(next);
    expect(await finance()).toEqual(before);
    expect((await rows()).find(r => r.reservation_id === next.reservationId)!.execution_recovery_slot).toBe(50);
    // Corrupt a receipt beyond the first audit page; no new work may ignore it.
    await db.executor.updateTable('ai_funded_usage_reservations').set({ execution_admission_release: '{}' })
      .where('reservation_id', '=', saved[104].reservation_id).execute();
    await expect(authorize('corrupt-later-page')).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('allows exactly twenty dollars of captured unknown liability but retains a request that exceeds it', async () => {
    await end(await start('twelve-dollars', 12_000_000));
    await end(await start('eight-dollars', 8_000_000));
    expect((await rows()).every(r => r.execution_admission_release !== null)).toBe(true);
    const pending = await start('one-micro-over', 1); const before = await finance(); await end(pending);
    expect(await finance()).toEqual(before);
    expect((await rows()).find(r => r.reservation_id === pending.reservationId)!.execution_admission_release).toBeNull();
    await expect(authorize('blocked-over-liability')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('operator recovery allocates the third free slot with immutable replay and financial holds intact', async () => {
    for (const key of ['older-a', 'older-b']) await end(await start(key));
    const third = await start('operator-third'); now = new Date(now.getTime() + 20 * 60_000);
    const request = { expectedOwnerId: identity.ownerId, reservationId: third.reservationId, tokenId: third.tokenId,
      expectedRequestId: third.requestId, expectedStartedAt: third.startedAt, expectedExpiresAt: third.expiresAt,
      maximumLiabilityMicrousd: 100, localRunId: 'operator-local-third', localRunState: 'failed' as const,
      localRunEndedAt: new Date(Date.parse(third.startedAt) + 1_000).toISOString(), reviewer: 'operator:fixture',
      evidenceRef: 'support:capacity', acceptUnknownUpstreamLiability: true as const };
    const before = await finance(); const result = await repo.releaseExecutionAdmission(identity, request);
    expect(result.executionAdmissionReleased).toBe(true); expect(await finance()).toEqual(before);
    expect((await rows()).find(r => r.reservation_id === third.reservationId)!.execution_recovery_slot).toBe(2);
    expect(await repo.releaseExecutionAdmission(identity, request)).toEqual(result);
  });

  it('database permits more than SMALLINT slots but rejects negative and duplicate unresolved slots', async () => {
    await end(await start('database-boundary'));
    const first = (await rows())[0];
    await db.executor.updateTable('ai_funded_usage_reservations').set({ execution_recovery_slot: 40_000 }).where('reservation_id', '=', first.reservation_id).execute();
    await expect(db.executor.updateTable('ai_funded_usage_reservations').set({ execution_recovery_slot: -1 })
      .where('reservation_id', '=', first.reservation_id).execute()).rejects.toThrow();
    await end(await start('database-peer'));
    const second = (await rows())[1];
    await expect(db.executor.updateTable('ai_funded_usage_reservations').set({ execution_recovery_slot: 40_000 })
      .where('reservation_id', '=', second.reservation_id).execute()).rejects.toThrow();
  });

  it.each([22, 23])('upgrades generation%i two-slot databases without rewriting existing receipts or financial rows', async generation => {
    for (const key of ['legacy-a', 'legacy-b']) await end(await start(key));
    await sql`ALTER TABLE ai_funded_usage_reservations
      DROP CONSTRAINT ai_funded_execution_recovery_slot_check,
      ALTER COLUMN execution_recovery_slot TYPE SMALLINT,
      ADD CONSTRAINT ai_funded_execution_recovery_slot_check CHECK (execution_recovery_slot IN (0, 1))`.execute(db.executor);
    await sql`UPDATE platform_schema_revisions SET generation=${generation},
      fingerprint='588aa2cb52e99cfd8d48cf0ddd92f5f663aa266f2a5a1b40b099f7b92af5d3f0'
      WHERE scope='core'`.execute(db.executor);
    const beforeRows = await rows(); const beforeFinance = await finance();
    expect(PLATFORM_SCHEMA_REVISION.generation).toBeGreaterThan(generation);
    await runPlatformMigration(db.executor, migratePlatformSchema, { revision: PLATFORM_SCHEMA_REVISION });
    expect(await rows()).toEqual(beforeRows); expect(await finance()).toEqual(beforeFinance);
    await end(await start('after-upgrade'));
    expect((await rows())[2].execution_recovery_slot).toBe(2);
    const recoveredRows = await rows(), recoveredFinance = await finance();
    await runPlatformMigration(db.executor, async () => { throw new Error('Old source must not execute DDL'); }, {
      revision: { generation, fingerprint: '588aa2cb52e99cfd8d48cf0ddd92f5f663aa266f2a5a1b40b099f7b92af5d3f0' },
    });
    expect(await rows()).toEqual(recoveredRows);
    expect(await finance()).toEqual(recoveredFinance);
    await db.executor.updateTable('ai_funded_usage_reservations').set({ execution_recovery_slot: 99 })
      .where('reservation_id', '=', beforeRows[0].reservation_id).execute();
    expect((await rows())[0].execution_recovery_slot).toBe(99);
  });
});
