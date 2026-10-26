import { isManagedWorkersAiModel, managedWorkersAiModel } from "@matrix-os/contracts";
import { WORKERS_AI_PRICE_SNAPSHOTS } from "./funded-workers-pricing.js";
import { z } from "zod/v4";
import { FUNDED_PRICING_VERSIONS, validateFundedPricingReview, type FundedPricingReviews } from "./funded-pricing-review.js";

const NATIVE_SONNET_5 = "claude-sonnet-5";
// Cloudflare's catalog identifier; provider-native Anthropic requests use the
// bare ID above. https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5/
const CANONICAL_SONNET_5 = "anthropic/claude-sonnet-5";
export const FUNDED_GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
const SAFETY_MARGIN_NUMERATOR = 120;
const SAFETY_MARGIN_DENOMINATOR = 100;
const TokenCountSchema = z.number().int().nonnegative().max(10_000_000);
const OutputTokenCountSchema = z.number().int().positive().max(128_000);

interface FundedPricing {
  canonicalModelId: string;
  version: string;
  validThrough: string;
  inputRateThousandths: number;
  outputRateThousandths: number;
  cacheReadRateThousandths: number;
  cacheWrite5mRateThousandths: number;
  cacheWrite1hRateThousandths: number;
}

// Standard rates re-verified 2026-10-02; renewal requires an explicit operator review.
// https://platform.claude.com/docs/en/about-claude/pricing
// The historical deadline remains expired unless an operator re-attests it.
const CURRENT_PRICING: FundedPricing = {
  canonicalModelId: CANONICAL_SONNET_5,
  version: FUNDED_PRICING_VERSIONS[CANONICAL_SONNET_5],
  validThrough: "2026-09-30T23:59:59.999Z",
  inputRateThousandths: 2_000,
  outputRateThousandths: 10_000,
  cacheReadRateThousandths: 200,
  cacheWrite5mRateThousandths: 2_500,
  cacheWrite1hRateThousandths: 4_000,
};
const WORKERS_PRICING: FundedPricing[] = Object.entries(WORKERS_AI_PRICE_SNAPSHOTS).map(([id, price]) => ({
  canonicalModelId: id, version: price.version, validThrough: "2026-09-30T23:59:59.999Z",
  inputRateThousandths: price.input, outputRateThousandths: price.output,
  cacheReadRateThousandths: price.cached, cacheWrite5mRateThousandths: price.input,
  cacheWrite1hRateThousandths: price.input,
}));
const ALL_PRICING = [CURRENT_PRICING, ...WORKERS_PRICING];

/** Readiness and admission resolve the same model-specific review. */
export function fundedModelPriceValidThrough(modelId: string, reviews: FundedPricingReviews = []): string | undefined {
  const pricing = ALL_PRICING.find((item) => item.canonicalModelId === modelId);
  if (!pricing) return undefined;
  const review = reviews.find((item) => item.canonicalModelId === modelId);
  if (review) validateFundedPricingReview(review);
  return review?.validThrough ?? pricing.validThrough;
}

export function isFundedModelPriceCurrent(modelId: string, now: Date, reviews: FundedPricingReviews = []): boolean {
  const validThrough = fundedModelPriceValidThrough(modelId, reviews);
  const reviewedAt = reviews.find((item) => item.canonicalModelId === modelId)?.reviewedAt;
  const time = now.getTime();
  return !!validThrough && Number.isFinite(time) && time <= Date.parse(validThrough)
    && (!reviewedAt || time >= Date.parse(reviewedAt));
}

// Retain the previous version only for safe settlement of reservations created
// before this deployment. It is never selected for new reservations.
const SETTLEMENT_PRICING: Readonly<Record<string, FundedPricing>> = {
  "anthropic-2026-08-29": {
    canonicalModelId: CANONICAL_SONNET_5, version: "anthropic-2026-08-29",
    validThrough: "2026-09-30T23:59:59.999Z", inputRateThousandths: 2_000, outputRateThousandths: 10_000,
    cacheReadRateThousandths: 200, cacheWrite5mRateThousandths: 2_500, cacheWrite1hRateThousandths: 4_000,
  },
  [CURRENT_PRICING.version]: CURRENT_PRICING,
  ...Object.fromEntries(WORKERS_PRICING.map(price => [price.version, price])),
};

export interface FundedModelMapping {
  nativeModelId: string;
  canonicalModelId: string;
}

export interface FundedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export function mapFundedModel(modelId: string): FundedModelMapping {
  if (isManagedWorkersAiModel(modelId)) return { nativeModelId: modelId, canonicalModelId: modelId };
  if (modelId !== NATIVE_SONNET_5) throw new Error("Unsupported funded AI model");
  return { nativeModelId: NATIVE_SONNET_5, canonicalModelId: CANONICAL_SONNET_5 };
}

/** Provider-enforced ceiling, NOT a local tokenizer estimate. Anthropic
 * admission uses the provider-counted request size; Workers AI uses this
 * conservative fallback until it exposes a trusted preflight count. Keep it
 * reviewed with the expiring price table. Sonnet 5 has a 1M context:
 * https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5
 */
export function maximumFundedInputTokens(canonicalModelId: string): number {
  // Live account catalog ceiling is deliberately used for liability (not credit
  // admission), even though the public model page currently lists 1,048,576.
  const workersModel = managedWorkersAiModel(canonicalModelId);
  if (workersModel) return workersModel.maximumInputTokens;
  if (canonicalModelId !== CANONICAL_SONNET_5) throw new Error("Unsupported funded AI model");
  return 1_000_000;
}

export function estimateWorstCaseMicrousd(input: {
  canonicalModelId: string;
  inputTokens: number;
  maxOutputTokens: number;
  now: Date;
  pricingReviews?: FundedPricingReviews;
}): { amountMicrousd: number; pricingVersion: string; pricingValidThrough: string } {
  const pricing = ALL_PRICING.find((item) => item.canonicalModelId === input.canonicalModelId);
  if (!pricing) throw new Error("Funded AI pricing is unavailable");
  if (!isFundedModelPriceCurrent(input.canonicalModelId, input.now, input.pricingReviews)) {
    throw new Error("Funded AI pricing has expired or its review is not current");
  }
  const inputTokens = TokenCountSchema.parse(input.inputTokens);
  const maxOutputTokens = OutputTokenCountSchema.parse(input.maxOutputTokens);
  // Any counted input token may become a 1-hour cache write, the most
  // expensive supported input operation. Reserving that upper bound keeps
  // admission safe even when cache_control is nested in prompt content.
  const baseThousandths = inputTokens * pricing.cacheWrite1hRateThousandths
    + maxOutputTokens * pricing.outputRateThousandths;
  const amountMicrousd = Math.ceil(
    baseThousandths * SAFETY_MARGIN_NUMERATOR / SAFETY_MARGIN_DENOMINATOR / 1_000,
  );
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd <= 0) {
    throw new Error("Funded AI cost estimate exceeds supported bounds");
  }
  return {
    amountMicrousd,
    pricingVersion: pricing.version,
    pricingValidThrough: fundedModelPriceValidThrough(input.canonicalModelId, input.pricingReviews)!,
  };
}

export function priceActualUsageMicrousd(input: {
  canonicalModelId: string;
  pricingVersion: string;
  usage: FundedTokenUsage;
}): number {
  const pricing = SETTLEMENT_PRICING[input.pricingVersion];
  if (!pricing || pricing.canonicalModelId !== input.canonicalModelId) {
    throw new Error("Funded AI pricing version is unavailable");
  }
  const inputTokens = TokenCountSchema.parse(input.usage.inputTokens);
  const outputTokens = TokenCountSchema.parse(input.usage.outputTokens);
  const cacheReadTokens = TokenCountSchema.parse(input.usage.cacheReadTokens);
  const cacheWrite5mTokens = TokenCountSchema.parse(input.usage.cacheWrite5mTokens);
  const cacheWrite1hTokens = TokenCountSchema.parse(input.usage.cacheWrite1hTokens);
  // Rates are stored in thousandths of a microusd so discounted cache pricing
  // remains integer-only through the calculation.
  const numerator = inputTokens * pricing.inputRateThousandths
    + outputTokens * pricing.outputRateThousandths
    + cacheReadTokens * pricing.cacheReadRateThousandths
    + cacheWrite5mTokens * pricing.cacheWrite5mRateThousandths
    + cacheWrite1hTokens * pricing.cacheWrite1hRateThousandths;
  const amountMicrousd = Math.ceil(numerator / 1_000);
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd < 0) {
    throw new Error("Funded AI actual cost exceeds supported bounds");
  }
  return amountMicrousd;
}
