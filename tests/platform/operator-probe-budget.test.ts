import { describe, expect, it } from 'vitest';
import { OperatorProbeBeginSchema, OperatorProbeFinalizeSchema, OperatorProbePolicySchema,
  quoteOperatorProbeMicrousd, priceOperatorProbeUsageMicrousd } from '../../packages/contracts/src/funded-operator-probe.js';
import { beginInput, policy, usage } from './operator-probe-budget-fixture.js';
describe('operator probe economic contract', () => {
  it('covers the reviewed full-context cache-write risk with 120% and integer rounding', () => {
    expect(quoteOperatorProbeMicrousd(policy)).toBe(4_800_012);
    expect(priceOperatorProbeUsageMicrousd(policy, usage)).toBe(25);
    expect(OperatorProbePolicySchema.safeParse({ ...policy, maximumCostMicrousd: 4_800_011 }).success).toBe(false);
  });
  it('rejects caller wallet overrides, unknown fields, invalid ranges and optimistic bounds', () => {
    expect(OperatorProbeBeginSchema.safeParse({ ...beginInput(), budgetId: 'other' }).success).toBe(false);
    expect(OperatorProbePolicySchema.safeParse({ ...policy, maximumOutputTokens: 2 }).success).toBe(false);
    const finalize = { protocolVersion: 1, probeId: beginInput().probeId, executionId: beginInput().executionId,
      economicHash: 'a'.repeat(64), outcome: 'ready', usage, providerReferenceHash: null };
    expect(OperatorProbeFinalizeSchema.safeParse(finalize).success).toBe(true);
    for (const count of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(OperatorProbeFinalizeSchema.safeParse({ ...finalize, usage: { ...usage, inputTokens: count } }).success).toBe(false);
    }
  });
});

it('does not round large cost arithmetic through unsafe floating point', () => {
  const large = { ...policy, maximumInputTokens: 10_000_000, inputRateThousandths: 100_000_000,
    cacheWrite1hRateThousandths: 100_000_000, maximumCostMicrousd: 1_200_000_000_012 };
  expect(quoteOperatorProbeMicrousd(large)).toBe(1_200_000_000_012);
  expect(OperatorProbePolicySchema.safeParse({ ...policy, cacheWrite1hRateThousandths: Number.MAX_SAFE_INTEGER }).success).toBe(false);
});
