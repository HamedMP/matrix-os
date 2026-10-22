import { expect, it } from 'vitest';
import { loadSubscriptionAiCreditPolicy } from '../../packages/platform/src/subscription-ai-credit-policy.js';

it('keeps subscription allowances disabled until explicitly activated', () => {
  expect(loadSubscriptionAiCreditPolicy({})).toEqual({ enabled: false });
  expect(loadSubscriptionAiCreditPolicy({ MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'false',
    MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON: '{arbitrary legacy input' })).toEqual({ enabled: false });
});
it('uses only the approved concrete tier amounts', () => {
  expect(loadSubscriptionAiCreditPolicy({ MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true' })).toEqual({
    enabled: true, amountsMicrousd: { matrix_starter: 5_000_000, matrix_builder: 10_000_000, matrix_max: 20_000_000 },
  });
});
it('fails closed if an operator tries to activate the obsolete arbitrary policy format', () => {
  expect(() => loadSubscriptionAiCreditPolicy({ MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true',
    MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON: '{}' })).toThrow(/reviewed/);
});
