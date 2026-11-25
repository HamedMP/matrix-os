import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { FREE_MANAGED_MODEL_ID, readDailyFundedSpend } from '../../packages/platform/src/free-tier/funded-policy.js';
import { FREE_PREPAID_UNKNOWN_USAGE_GRACE_MS } from '../../packages/platform/src/free-tier/prepaid-unknown-usage.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';
import { assertFundedConservativeFence } from '../../packages/platform/src/database/funded-conservative-fence.js';
import { insertFreeMetalRuntime } from './free-funded-test-helper.js';

/**
 * A free runtime's prepaid request whose final usage never arrived stays
 * unresolved and keeps blocking the owner's next funded request. Once its
 * reservation has expired and the grace period has passed, the sweep releases
 * it with no customer debit; it still counts in the free daily ceiling, and an
 * exact settlement that arrives before then wins. Ported from PR #3437 with
 * the free container runtime swapped for a free metal runtime (ENG-520 P7).
 */

const MODEL = FREE_MANAGED_MODEL_ID;
const T0 = new Date('2026-09-10T12:00:00.000Z');
const MINUTE = 60_000;

function harness(dbs: () => PlatformDB, clock: { now: Date }) {
  const repository = (db = dbs()) => createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32),
    now: () => new Date(clock.now), freeFunding: { dailyFundedSpendMicrousd: 100_000_000 } });

  async function runtime(input: { free: boolean }) {
    const repo = repository();
    await dbs().executor.updateTable('ai_funded_global_policy')
      .set({ enabled: true, allowed_model_ids: JSON.stringify([MODEL]), revision: 1 })
      .where('policy_id', '=', 'default').execute();
    const identity = { ownerId: 'user_unknown', machineId: 'machine-unknown', runtimeSlot: 'primary' };
    if (input.free) {
      await insertFreeMetalRuntime(dbs(), { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'unknown', at: T0 });
    } else {
      await insertUserMachine(dbs(), {
        machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'unknown', status: 'running',
        imageVersion: 'b1', provisionedAt: T0.toISOString(), activationState: 'authorized',
      });
    }
    await dbs().transaction((trx) => initializeCustomerFundedStarterPolicy(trx, identity.machineId, { now: T0.toISOString(), env: {
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
      AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32),
    } }));
    const { credential } = await repo.issueRuntimeCredential(identity);
    let n = 0;
    const lostUsage = async () => {
      n += 1;
      const auth = await repo.authorize({ credential: credential.token, requestId: `request_${n}`, modelId: MODEL,
        maxCostMicrousd: 1_000, billingMode: 'usage', ...(input.free ? {} : { billingPolicy: 'postpaid' as const }) });
      const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
      const start = await repo.startReservation({ ...key, executionId: `execution_${n}` });
      await repo.recordTerminalOutcome({ contractVersion: 1, ...key, ...identity, requestId: `request_${n}`,
        startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: `execution_${n}`,
        terminalState: 'completed', terminalAt: clock.now.toISOString(), outcome: 'usage_unknown' });
      return { key, hold: auth.reservation.reservedMicrousd, expiresAt: start.expiresAt };
    };
    // A runtime credential lives shorter than an in-flight request, so later requests use a fresh one.
    const next = async () => repo.authorize({ credential: (await repo.issueRuntimeCredential(identity)).credential.token,
      requestId: `next_${++n}`, modelId: MODEL, maxCostMicrousd: 1_000, billingMode: 'usage',
      ...(input.free ? {} : { billingPolicy: 'postpaid' as const }) });
    const row = (reservationId: string) => dbs().executor.selectFrom('ai_funded_usage_reservations')
      .select(['status', 'actual_microusd', 'finalization_mode', 'customer_charge_release', 'execution_admission_release'])
      .where('reservation_id', '=', reservationId).executeTakeFirstOrThrow();
    return { repo, identity, lostUsage, next, row };
  }
  const pastGrace = (expiresAt: string) => { clock.now = new Date(Date.parse(expiresAt) + FREE_PREPAID_UNKNOWN_USAGE_GRACE_MS + 1); };
  return { repository, runtime, pastGrace };
}

describe('free prepaid requests with unknown usage', () => {
  let db: PlatformDB;
  const time = { now: new Date(T0) };
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); time.now = new Date(T0); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const { runtime, pastGrace } = harness(() => db, time);

  it('keeps the hold reserved and the owner blocked while the usage is unknown', async () => {
    const owner = await runtime({ free: true });
    const { key, hold, expiresAt } = await owner.lostUsage();
    expect(hold).toBeGreaterThan(0);
    expect(await owner.row(key.reservationId)).toMatchObject({ status: 'in_flight', actual_microusd: null,
      customer_charge_release: null, execution_admission_release: null });
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ reservedMicrousd: hold });
    await expect(owner.next()).rejects.toMatchObject({ code: 'rate_limited' });
    // Past its expiry but inside the grace period it is still unresolved, and the cleanup does not release it.
    time.now = new Date(Date.parse(expiresAt) + MINUTE);
    await owner.repo.cleanupExpiredReservations({ limit: 100 });
    expect(await owner.row(key.reservationId)).toMatchObject({ status: 'in_flight', customer_charge_release: null });
    await expect(owner.next()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('releases the hold with no debit once the grace has passed, keeps it in the daily ceiling, and unblocks the owner', async () => {
    const owner = await runtime({ free: true });
    const before = await owner.repo.getFundingSummary(owner.identity);
    const { key, hold, expiresAt } = await owner.lostUsage();
    pastGrace(expiresAt);
    expect(await owner.repo.cleanupExpiredReservations({ limit: 100 })).toBe(1);
    const released = await owner.row(key.reservationId);
    expect(released).toMatchObject({ status: 'expired', actual_microusd: null });
    expect(JSON.parse(released.customer_charge_release!)).toMatchObject({ reason: 'usage_unknown', releasedMicrousd: hold });
    // No customer debit and the month budget is untouched; the daily ceiling still counts the hold.
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ reservedMicrousd: 0, settledThisMonthMicrousd: 0,
      remainingBalanceMicrousd: before.remainingBalanceMicrousd, remainingBudgetMicrousd: before.remainingBudgetMicrousd });
    expect(await readDailyFundedSpend(db.executor, time.now)).toBe(hold);
    expect(await owner.repo.cleanupExpiredReservations({ limit: 100 })).toBe(0);
    await expect(owner.next()).resolves.toMatchObject({ authorized: true });
    await expect(assertFundedConservativeFence(db.executor)).resolves.toBeUndefined();
  });

  it('keeps the hold reserved and blocking when a legacy relay finalizes conservatively', async () => {
    const owner = await runtime({ free: true });
    const { key, hold, expiresAt } = await owner.lostUsage();
    await expect(owner.repo.finalizeReservation({ ...key, mode: 'conservative' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await owner.row(key.reservationId)).toMatchObject({ status: 'in_flight', customer_charge_release: null });
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ reservedMicrousd: hold });
    await expect(owner.next()).rejects.toMatchObject({ code: 'rate_limited' });
    // A retry answers the same and still leaves it for the sweep.
    await expect(owner.repo.finalizeReservation({ ...key, mode: 'conservative' })).rejects.toMatchObject({ code: 'unavailable' });
    pastGrace(expiresAt);
    expect(await owner.repo.cleanupExpiredReservations({ limit: 100 })).toBe(1);
    await expect(owner.next()).resolves.toMatchObject({ authorized: true });
  });

  it('settles at the exact cost when exact usage arrives before the sweep', async () => {
    const owner = await runtime({ free: true });
    const { key, expiresAt } = await owner.lostUsage();
    await owner.repo.finalizeReservation({ ...key, mode: 'exact', actualCostMicrousd: 24 });
    expect(await owner.row(key.reservationId)).toMatchObject({ status: 'settled', actual_microusd: 24, finalization_mode: 'exact' });
    pastGrace(expiresAt);
    await owner.repo.cleanupExpiredReservations({ limit: 100 });
    expect(await owner.row(key.reservationId)).toMatchObject({ status: 'settled', actual_microusd: 24 });
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ settledThisMonthMicrousd: 24 });
  });

  it('still releases a paid postpaid request with unknown usage at once, charging nothing', async () => {
    const owner = await runtime({ free: false });
    const { key } = await owner.lostUsage();
    const released = await owner.row(key.reservationId);
    expect(released).toMatchObject({ status: 'expired', actual_microusd: null });
    expect(released.customer_charge_release).not.toBeNull();
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ reservedMicrousd: 0, settledThisMonthMicrousd: 0 });
  });
});

describe.skipIf(!freeTierPostgresUrl)('free prepaid unknown usage on a real PostgreSQL server', () => {
  let scoped: ScopedPlatformDbs;
  const time = { now: new Date(T0) };
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_unknown_hold', 2); });
  afterAll(async () => { await scoped?.close(); });

  it('resolves a sweep racing a late exact settlement exactly once, never charging twice', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const { repository, runtime, pastGrace } = harness(() => a, time);
    const owner = await runtime({ free: true });
    const before = await owner.repo.getFundingSummary(owner.identity);
    const { key, expiresAt } = await owner.lostUsage();
    pastGrace(expiresAt);
    const [swept] = await Promise.all([
      repository(a).cleanupExpiredReservations({ limit: 100 }),
      repository(b).finalizeReservation({ ...key, mode: 'exact', actualCostMicrousd: 24 }),
      repository(b).cleanupExpiredReservations({ limit: 100 }),
    ]);
    expect(swept).toBeLessThanOrEqual(1);
    const settled = await owner.row(key.reservationId);
    expect({ status: settled.status, actual: Number(settled.actual_microusd) }).toEqual({ status: 'settled', actual: 24 });
    const after = await owner.repo.getFundingSummary(owner.identity);
    // Either the exact settlement won and charged 24, or the sweep released first and the cost was absorbed.
    expect([before.remainingBalanceMicrousd, before.remainingBalanceMicrousd - 24]).toContain(after.remainingBalanceMicrousd);
    expect(after.reservedMicrousd).toBe(0);
    expect(await owner.repo.cleanupExpiredReservations({ limit: 100 })).toBe(0);
    await expect(assertFundedConservativeFence(a.executor)).resolves.toBeUndefined();
  });
});
