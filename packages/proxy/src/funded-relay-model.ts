import { z } from "zod/v4";

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
  inputRateHundredths: number;
  outputRateHundredths: number;
  cacheReadRateHundredths: number;
  cacheWrite5mRateHundredths: number;
  cacheWrite1hRateHundredths: number;
}

// Anthropic made Sonnet 5's $2/$10 introductory rate permanent on 2026-08-31.
// https://platform.claude.com/docs/en/about-claude/pricing
// Keep the review horizon deliberately short so a stale list price fails closed.
const CURRENT_PRICING: FundedPricing = {
  canonicalModelId: CANONICAL_SONNET_5,
  version: "anthropic-2026-08-31-standard",
  validThrough: "2026-09-30T23:59:59.999Z",
  inputRateHundredths: 200,
  outputRateHundredths: 1_000,
  cacheReadRateHundredths: 20,
  cacheWrite5mRateHundredths: 250,
  cacheWrite1hRateHundredths: 400,
};
// Verified 2026-09-10: https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/
const GLM_PRICING: FundedPricing = {
  canonicalModelId: FUNDED_GLM_FLASH,
  version: "cloudflare-2026-09-10-glm-flash",
  validThrough: "2026-09-30T23:59:59.999Z",
  inputRateHundredths: 15, outputRateHundredths: 50, cacheReadRateHundredths: 3,
  cacheWrite5mRateHundredths: 15, cacheWrite1hRateHundredths: 15,
};

// Retain the previous version only for safe settlement of reservations created
// before this deployment. It is never selected for new reservations.
const SETTLEMENT_PRICING: Readonly<Record<string, FundedPricing>> = {
  "anthropic-2026-08-29": { ...CURRENT_PRICING, version: "anthropic-2026-08-29" },
  [CURRENT_PRICING.version]: CURRENT_PRICING,
  [GLM_PRICING.version]: GLM_PRICING,
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
  if (modelId === FUNDED_GLM_FLASH) return { nativeModelId: modelId, canonicalModelId: modelId };
  if (modelId !== NATIVE_SONNET_5) throw new Error("Unsupported funded AI model");
  return { nativeModelId: NATIVE_SONNET_5, canonicalModelId: CANONICAL_SONNET_5 };
}

/** Provider-enforced ceiling, NOT a local tokenizer estimate. Usage admission
 * uses this to bound Matrix liability, never as the credit required from a user.
 * Keep it reviewed with the expiring price table. Sonnet 5 has a 1M context:
 * https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5
 */
export function maximumFundedInputTokens(canonicalModelId: string): number {
  // Live account catalog ceiling is deliberately used for liability (not credit
  // admission), even though the public model page currently lists 1,048,576.
  if (canonicalModelId === FUNDED_GLM_FLASH) return 1_310_720;
  if (canonicalModelId !== CANONICAL_SONNET_5) throw new Error("Unsupported funded AI model");
  return 1_000_000;
}

export function estimateWorstCaseMicrousd(input: {
  canonicalModelId: string;
  inputTokens: number;
  maxOutputTokens: number;
  now: Date;
}): { amountMicrousd: number; pricingVersion: string; pricingValidThrough: string } {
  const pricing = [CURRENT_PRICING, GLM_PRICING].find((item) => item.canonicalModelId === input.canonicalModelId);
  if (!pricing) throw new Error("Funded AI pricing is unavailable");
  if (input.now.getTime() > Date.parse(pricing.validThrough)) {
    throw new Error("Funded AI pricing has expired");
  }
  const inputTokens = TokenCountSchema.parse(input.inputTokens);
  const maxOutputTokens = OutputTokenCountSchema.parse(input.maxOutputTokens);
  // Any counted input token may become a 1-hour cache write, the most
  // expensive supported input operation. Reserving that upper bound keeps
  // admission safe even when cache_control is nested in prompt content.
  const baseHundredths = inputTokens * pricing.cacheWrite1hRateHundredths
    + maxOutputTokens * pricing.outputRateHundredths;
  const amountMicrousd = Math.ceil(
    baseHundredths * SAFETY_MARGIN_NUMERATOR / SAFETY_MARGIN_DENOMINATOR / 100,
  );
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd <= 0) {
    throw new Error("Funded AI cost estimate exceeds supported bounds");
  }
  return {
    amountMicrousd,
    pricingVersion: pricing.version,
    pricingValidThrough: pricing.validThrough,
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
  // Rates are stored in hundredths of a microusd so discounted cache pricing
  // remains integer-only through the calculation.
  const numerator = inputTokens * pricing.inputRateHundredths
    + outputTokens * pricing.outputRateHundredths
    + cacheReadTokens * pricing.cacheReadRateHundredths
    + cacheWrite5mTokens * pricing.cacheWrite5mRateHundredths
    + cacheWrite1hTokens * pricing.cacheWrite1hRateHundredths;
  const amountMicrousd = Math.ceil(numerator / 100);
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd < 0) {
    throw new Error("Funded AI actual cost exceeds supported bounds");
  }
  return amountMicrousd;
}
