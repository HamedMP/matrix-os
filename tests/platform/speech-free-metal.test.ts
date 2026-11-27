import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import {
  ensureSpeechMonthlyAllowance,
  reconcileSpeechMonthlyAllowances,
} from '../../packages/platform/src/speech/allowance.js';
import { createAiFundedSpeechFundingPort } from '../../packages/platform/src/speech/funding.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertFreeMetalRuntime } from './free-funded-test-helper.js';

/**
 * Speech funding never reaches a free metal runtime (spec 2691 D2, ENG-520 P7
 * fix round 1). Free metal VMs keep the `customer` class, which the speech
 * allowance and reserve paths gate on; on #3437's container base the `free`
 * class kept them out. Faults detected: a Matrix-paid monthly speech credit or
 * a speech hold against a free runtime's starter or allowance credit, and a
 * regression for paid customer machines.
 */

const NOW = new Date('2026-09-10T12:00:00.000Z');
const FREE = { ownerId: 'user_freespeech', machineId: 'metal-free-speech', runtimeSlot: 'primary' } as const;
const PAID = { ownerId: 'user_paidspeech', machineId: 'vps-paid-speech', runtimeSlot: 'primary' } as const;
const ALLOWANCE = { monthlyBudgetMicrousd: 1_000_000, monthlyPromotionalCreditMicrousd: 1_000_000 };

describe('speech funding for a free metal runtime', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertFreeMetalRuntime(db, { machineId: FREE.machineId, clerkUserId: FREE.ownerId, handle: 'freespeech', at: NOW });
    await insertUserMachine(db, {
      machineId: PAID.machineId, clerkUserId: PAID.ownerId, handle: 'paidspeech', runtimeSlot: 'primary',
      status: 'running', imageVersion: 'v1', provisionedAt: NOW.toISOString(), activationState: 'authorized',
    });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  const ensure = (identity: typeof FREE | typeof PAID) => db.transaction((trx) =>
    ensureSpeechMonthlyAllowance(trx.executor, identity, { ...ALLOWANCE, now: NOW }));

  function port(reservationId: string, monthly: boolean) {
    return createAiFundedSpeechFundingPort({
      allowedSources: ['promotional'], credentialHashSecret: 's'.repeat(32),
      reservationIdFactory: () => reservationId, now: () => NOW,
      ...(monthly ? { monthlyAllowance: ALLOWANCE } : {}),
    });
  }

  const reserve = (identity: typeof FREE | typeof PAID, funding: ReturnType<typeof port>, suffix: string) =>
    db.transaction((trx) => funding.reserve(trx.executor, {
      identity, requestId: `sp_${NOW.getTime()}_${suffix}`, policyRevision: 'speech-1',
      modelId: 'gpt-4o-transcribe', maximumCostMicrousd: 120,
    }));

  const ledger = (machineId: string) => db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
    .where('machine_id', '=', machineId).execute();
  const holds = (machineId: string) => db.executor.selectFrom('ai_funded_usage_reservations').select('reservation_id')
    .where('machine_id', '=', machineId).execute();

  it('grants a free metal runtime no monthly speech allowance', async () => {
    await expect(ensure(FREE)).rejects.toThrow();
    expect(await db.executor.selectFrom('speech_runtime_allowances').selectAll()
      .where('machine_id', '=', FREE.machineId).execute()).toEqual([]);
    expect(await ledger(FREE.machineId)).toEqual([]);
  });

  it('refuses a free metal runtime a monthly speech hold', async () => {
    await expect(reserve(FREE, port('speech_free_monthly', true), 'freemonthlyabcdef')).rejects.toMatchObject({ code: 'unavailable' });
    expect(await holds(FREE.machineId)).toEqual([]);
    expect(await ledger(FREE.machineId)).toEqual([]);
  });

  it('refuses a free metal runtime a speech hold against its starter or allowance credit', async () => {
    const funded = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => NOW });
    await funded.setRuntimePolicy({ identity: FREE, expectedRevision: 0, enabled: false, allowedModelIds: [],
      monthlyBudgetMicrousd: 10_000_000, expiresAt: null });
    await funded.grantCredit({ entryId: 'starter_free_speech', identity: FREE, kind: 'promotional_grant',
      amountMicrousd: 5_000_000, sourceReference: 'matrix-ai-lifetime-starter', expiresAt: null });
    await expect(reserve(FREE, port('speech_free_general', false), 'freegeneralabcdef')).rejects.toMatchObject({ code: 'unavailable' });
    expect(await holds(FREE.machineId)).toEqual([]);
  });

  it('leaves a paid customer machine with its speech allowance and hold', async () => {
    await ensure(PAID);
    expect(await db.executor.selectFrom('speech_runtime_allowances').select('machine_id')
      .where('machine_id', '=', PAID.machineId).execute()).toHaveLength(1);
    await expect(reserve(PAID, port('speech_paid_monthly', true), 'paidmonthlyabcdef'))
      .resolves.toMatchObject({ reservationId: 'speech_paid_monthly' });
  });

  it('skips free metal runtimes when reconciling monthly allowances', async () => {
    const result = await reconcileSpeechMonthlyAllowances({ db, ...ALLOWANCE, now: () => NOW });
    expect(result).toEqual({ eligible: 1, reconciled: 1, failed: 0 });
    expect(await db.executor.selectFrom('speech_runtime_allowances').select('machine_id').execute())
      .toEqual([{ machine_id: PAID.machineId }]);
  });
});
