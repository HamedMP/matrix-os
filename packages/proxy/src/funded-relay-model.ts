import { z } from "zod/v4";

const NATIVE_SONNET_5 = "claude-sonnet-5";
const CANONICAL_SONNET_5 = "anthropic/claude-sonnet-5";
const LONG_CONTEXT_THRESHOLD = 200_000;
const SAFETY_MARGIN_NUMERATOR = 120;
const SAFETY_MARGIN_DENOMINATOR = 100;
const TokenCountSchema = z.number().int().nonnegative().max(10_000_000);
const OutputTokenCountSchema = z.number().int().positive().max(128_000);

const PRICING = {
  [CANONICAL_SONNET_5]: {
    version: "anthropic-2026-08-29",
    validThrough: "2026-08-31T23:59:59.999Z",
    inputMicrousdPerToken: 2,
    outputMicrousdPerToken: 10,
    longInputMicrousdPerToken: 4,
    longOutputMicrousdPerToken: 15,
  },
} as const;

export interface FundedModelMapping {
  nativeModelId: typeof NATIVE_SONNET_5;
  canonicalModelId: typeof CANONICAL_SONNET_5;
}

export interface FundedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  const pricing = PRICING[input.canonicalModelId as keyof typeof PRICING];
  if (!pricing) throw new Error("Funded AI pricing is unavailable");
  if (input.now.getTime() > Date.parse(pricing.validThrough)) {
    throw new Error("Funded AI pricing has expired");
  }
  const inputTokens = TokenCountSchema.parse(input.inputTokens);
  const maxOutputTokens = OutputTokenCountSchema.parse(input.maxOutputTokens);
  const isLongContext = inputTokens > LONG_CONTEXT_THRESHOLD;
  const inputRate = isLongContext ? pricing.longInputMicrousdPerToken : pricing.inputMicrousdPerToken;
  const outputRate = isLongContext ? pricing.longOutputMicrousdPerToken : pricing.outputMicrousdPerToken;
  const base = inputTokens * inputRate + maxOutputTokens * outputRate;
  const amountMicrousd = Math.ceil(base * SAFETY_MARGIN_NUMERATOR / SAFETY_MARGIN_DENOMINATOR);
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
  const pricing = PRICING[input.canonicalModelId as keyof typeof PRICING];
  if (!pricing || pricing.version !== input.pricingVersion) {
    throw new Error("Funded AI pricing version is unavailable");
  }
  const inputTokens = TokenCountSchema.parse(input.usage.inputTokens);
  const outputTokens = TokenCountSchema.parse(input.usage.outputTokens);
  const cacheReadTokens = TokenCountSchema.parse(input.usage.cacheReadTokens);
  const cacheWriteTokens = TokenCountSchema.parse(input.usage.cacheWriteTokens);
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const isLongContext = totalInputTokens > LONG_CONTEXT_THRESHOLD;
  // Rates are stored in tenths of a microusd so discounted cache pricing
  // remains integer-only through the calculation.
  const numerator = isLongContext
    ? inputTokens * 40 + outputTokens * 150 + cacheReadTokens * 4 + cacheWriteTokens * 50
    : inputTokens * 20 + outputTokens * 100 + cacheReadTokens * 2 + cacheWriteTokens * 25;
  const amountMicrousd = Math.ceil(numerator / 10);
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd < 0) {
    throw new Error("Funded AI actual cost exceeds supported bounds");
  }
  return amountMicrousd;
}
