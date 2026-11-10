import { createHash } from 'node:crypto';
import { OperatorProbePolicySchema } from '@matrix-os/contracts/funded-operator-probe';
import type { FundedPricingReviews } from './funded-pricing-review.js';
import { estimateWorstCaseMicrousd, fundedProbeRates, mapFundedModel, maximumFundedInputTokens } from './funded-relay-model.js';
import { FUNDED_SONNET } from './funded-relay-readiness.js';
import { serializeFundedOpenAiRequest } from './funded-relay-openai-request.js';

export function operatorProbeBody(model: string): string {
  const messages = [{ role: 'user', content: 'ping' }];
  return model === FUNDED_SONNET
    ? JSON.stringify({ model: 'claude-sonnet-5', messages, stream: false, max_tokens: 1 })
    : serializeFundedOpenAiRequest({ model, messages, stream: false, max_tokens: 1, store: false }).body;
}

/** Shared by explicit wallet bootstrap and Relay admission. No startup grants. */
export function operatorProbePolicy(model: string, now: Date, pricingReviews?: FundedPricingReviews) {
  const mapping = mapFundedModel(model === FUNDED_SONNET ? 'claude-sonnet-5' : model);
  if (mapping.canonicalModelId !== model) throw new Error('Unsupported probe model');
  const maximumInputTokens = maximumFundedInputTokens(model);
  const quote = estimateWorstCaseMicrousd({ canonicalModelId: model, inputTokens: maximumInputTokens,
    maxOutputTokens: 1, now, pricingReviews });
  return OperatorProbePolicySchema.parse({ ...mapping, ...fundedProbeRates(model), maximumInputTokens,
    maximumOutputTokens: 1, maximumCostMicrousd: quote.amountMicrousd, pricingVersion: quote.pricingVersion,
    pricingValidThrough: quote.pricingValidThrough, requestFingerprint: createHash('sha256').update(operatorProbeBody(model)).digest('hex') });
}
