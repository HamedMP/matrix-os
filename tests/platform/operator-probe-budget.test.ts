import { spawnSync } from 'node:child_process';
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
    expect(OperatorProbeFinalizeSchema.safeParse({ ...finalize, usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER } }).success).toBe(true);
    for (const count of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
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

const postgresSuite = 'tests/platform/operator-probe-budget-postgres.test.ts';
function withoutPostgres(args: string[], suite = postgresSuite) {
  return spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', suite, ...args], {
    env: { ...process.env, MATRIX_TEST_POSTGRES_URL: undefined }, encoding: 'utf8', timeout: 15_000,
  });
}
it('discovers the real-PG suite without failing default runs when no fixture is configured', () => {
  const result = withoutPostgres(['--reporter=json']);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.numFailedTests).toBe(0); expect(report.numPendingTests).toBeGreaterThan(0);
  expect(report.numPassedTests).toBe(0);
});
it('rejects skipped or absent PG assertions under the dedicated CI reporter', () => {
  for (const suite of [postgresSuite, 'tests/platform/operator-probe-budget-routes.test.ts']) {
    const result = withoutPostgres(['--reporter=./scripts/ci/operator-probe-postgres-reporter.mjs'], suite);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Operator probe PostgreSQL qualification requires nonzero assertions and zero skips');
  }
});
