import { z } from "zod/v4";

const NATIVE_SONNET_5 = "claude-sonnet-5";
// Cloudflare's catalog identifier; provider-native Anthropic requests use the
// bare ID above. https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5/
const CANONICAL_SONNET_5 = "anthropic/claude-sonnet-5";
const SAFETY_MARGIN_NUMERATOR = 120;
const SAFETY_MARGIN_DENOMINATOR = 100;
const TokenCountSchema = z.number().int().nonnegative().max(10_000_000);
const OutputTokenCountSchema = z.number().int().positive().max(128_000);

interface FundedPricing {
  canonicalModelId: typeof CANONICAL_SONNET_5;
  version: string;
  validThrough: string;
  inputRateTenths: number;
  outputRateTenths: number;
  cacheReadRateTenths: number;
  cacheWrite5mRateTenths: number;
  cacheWrite1hRateTenths: number;
}

// Anthropic made Sonnet 5's $2/$10 introductory rate permanent on 2026-08-31.
// https://platform.claude.com/docs/en/about-claude/pricing
// Keep the review horizon deliberately short so a stale list price fails closed.
const CURRENT_PRICING: FundedPricing = {
  canonicalModelId: CANONICAL_SONNET_5,
  version: "anthropic-2026-08-31-standard",
  validThrough: "2026-09-30T23:59:59.999Z",
  inputRateTenths: 20,
  outputRateTenths: 100,
  cacheReadRateTenths: 2,
  cacheWrite5mRateTenths: 25,
  cacheWrite1hRateTenths: 40,
};

// Retain the previous version only for safe settlement of reservations created
// before this deployment. It is never selected for new reservations.
const SETTLEMENT_PRICING: Readonly<Record<string, FundedPricing>> = {
  "anthropic-2026-08-29": { ...CURRENT_PRICING, version: "anthropic-2026-08-29" },
  [CURRENT_PRICING.version]: CURRENT_PRICING,
};

export interface FundedModelMapping {
  nativeModelId: typeof NATIVE_SONNET_5;
  canonicalModelId: typeof CANONICAL_SONNET_5;
}

export interface FundedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export function mapFundedModel(modelId: string): FundedModelMapping {
  if (modelId !== NATIVE_SONNET_5) throw new Error("Unsupported funded AI model");
  return { nativeModelId: NATIVE_SONNET_5, canonicalModelId: CANONICAL_SONNET_5 };
}

export function estimateWorstCaseMicrousd(input: {
  canonicalModelId: string;
  inputTokens: number;
  maxOutputTokens: number;
  now: Date;
}): { amountMicrousd: number; pricingVersion: string; pricingValidThrough: string } {
  const pricing = CURRENT_PRICING.canonicalModelId === input.canonicalModelId
    ? CURRENT_PRICING
    : null;
  if (!pricing) throw new Error("Funded AI pricing is unavailable");
  if (input.now.getTime() > Date.parse(pricing.validThrough)) {
    throw new Error("Funded AI pricing has expired");
  }
  const inputTokens = TokenCountSchema.parse(input.inputTokens);
  const maxOutputTokens = OutputTokenCountSchema.parse(input.maxOutputTokens);
  // Any counted input token may become a 1-hour cache write, the most
  // expensive supported input operation. Reserving that upper bound keeps
  // admission safe even when cache_control is nested in prompt content.
  const baseTenths = inputTokens * pricing.cacheWrite1hRateTenths
    + maxOutputTokens * pricing.outputRateTenths;
  const amountMicrousd = Math.ceil(
    baseTenths * SAFETY_MARGIN_NUMERATOR / SAFETY_MARGIN_DENOMINATOR / 10,
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
  // Rates are stored in tenths of a microusd so discounted cache pricing
  // remains integer-only through the calculation.
  const numerator = inputTokens * pricing.inputRateTenths
    + outputTokens * pricing.outputRateTenths
    + cacheReadTokens * pricing.cacheReadRateTenths
    + cacheWrite5mTokens * pricing.cacheWrite5mRateTenths
    + cacheWrite1hTokens * pricing.cacheWrite1hRateTenths;
  const amountMicrousd = Math.ceil(numerator / 10);
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd < 0) {
    throw new Error("Funded AI actual cost exceeds supported bounds");
  }
  return amountMicrousd;
}
