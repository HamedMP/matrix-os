import {
  MATRIX_PI_DEFAULT_MAX_OUTPUT_TOKENS,
  ProviderModelReferenceSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { FundedTokenUsage } from "./funded-relay-model.js";

const MAX_ROUTE_CONFIG_BYTES = 16 * 1024;
const SAFE_ROUTE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SAFE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/;
const SAFE_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,2047}$/;
const SAFE_PRICING_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const TokenRateSchema = z.number().int().nonnegative().max(100_000_000);
const IsoTimestampSchema = z.iso.datetime({ offset: true });

const BedrockPricingSchema = z.object({
  version: z.string().regex(SAFE_PRICING_VERSION),
  reviewedAt: IsoTimestampSchema,
  validThrough: IsoTimestampSchema,
  inputRateHundredths: TokenRateSchema,
  outputRateHundredths: TokenRateSchema,
  cacheReadRateHundredths: TokenRateSchema,
  cacheWrite5mRateHundredths: TokenRateSchema,
  cacheWrite1hRateHundredths: TokenRateSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.validThrough) <= Date.parse(value.reviewedAt)) {
    ctx.addIssue({ code: "custom", path: ["validThrough"], message: "Pricing review window is invalid" });
  }
});

const BedrockRouteConfigSchema = z.object({
  routeId: z.string().regex(SAFE_ROUTE_ID),
  region: z.string().min(3).max(64).regex(SAFE_REGION),
  clientModelId: z.string().min(1).max(256).regex(SAFE_MODEL_ID),
  canonicalModelId: ProviderModelReferenceSchema,
  resolvedModel: z.string().min(1).max(256).regex(SAFE_MODEL_ID),
  inferenceProfile: z.string().min(1).max(2_048).regex(SAFE_MODEL_ID),
  maxInputTokens: z.number().int().positive().max(10_000_000),
  // A route advertised to Matrix Pi must accept the ordinary turn ceiling.
  // Lower provider limits fail startup closed instead of producing a model
  // that passes readiness but rejects every normal message before dispatch.
  maxOutputTokens: z.number().int().min(MATRIX_PI_DEFAULT_MAX_OUTPUT_TOKENS).max(128_000),
  pricing: BedrockPricingSchema,
}).strict();

export type BedrockRouteConfig = z.infer<typeof BedrockRouteConfigSchema>;

export function isBedrockPricingCurrent(route: BedrockRouteConfig, now: Date): boolean {
  const time = now.getTime();
  return Number.isFinite(time) && time >= Date.parse(route.pricing.reviewedAt)
    && time <= Date.parse(route.pricing.validThrough);
}

export function estimateBedrockWorstCaseMicrousd(input: {
  route: BedrockRouteConfig;
  inputTokens: number;
  maxOutputTokens: number;
  now: Date;
}): { amountMicrousd: number; pricingVersion: string; pricingValidThrough: string } {
  const inputTokens = TokenRateSchema.parse(input.inputTokens);
  const maxOutputTokens = z.number().int().positive().max(128_000).parse(input.maxOutputTokens);
  if (!isBedrockPricingCurrent(input.route, input.now)) {
    throw new Error("Bedrock pricing has expired or its review is not current");
  }
  const pricing = input.route.pricing;
  const maximumInputRate = Math.max(
    pricing.inputRateHundredths,
    pricing.cacheReadRateHundredths,
    pricing.cacheWrite5mRateHundredths,
    pricing.cacheWrite1hRateHundredths,
  );
  const baseHundredths = inputTokens * maximumInputRate
    + maxOutputTokens * pricing.outputRateHundredths;
  const amountMicrousd = Math.ceil(baseHundredths * 120 / 100 / 100);
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd <= 0) {
    throw new Error("Bedrock cost estimate exceeds supported bounds");
  }
  return { amountMicrousd, pricingVersion: pricing.version, pricingValidThrough: pricing.validThrough };
}

export function priceBedrockUsageMicrousd(input: {
  route: BedrockRouteConfig;
  pricingVersion: string;
  usage: FundedTokenUsage;
}): number {
  if (input.pricingVersion !== input.route.pricing.version) {
    throw new Error("Bedrock pricing version is unavailable");
  }
  const values = [input.usage.inputTokens, input.usage.outputTokens, input.usage.cacheReadTokens,
    input.usage.cacheWrite5mTokens, input.usage.cacheWrite1hTokens].map((value) => TokenRateSchema.parse(value));
  const [inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens] = values;
  const pricing = input.route.pricing;
  const numerator = inputTokens! * pricing.inputRateHundredths
    + outputTokens! * pricing.outputRateHundredths
    + cacheReadTokens! * pricing.cacheReadRateHundredths
    + cacheWrite5mTokens! * pricing.cacheWrite5mRateHundredths
    + cacheWrite1hTokens! * pricing.cacheWrite1hRateHundredths;
  const amountMicrousd = Math.ceil(numerator / 100);
  if (!Number.isSafeInteger(amountMicrousd) || amountMicrousd < 0) {
    throw new Error("Bedrock actual cost exceeds supported bounds");
  }
  return amountMicrousd;
}

export function resolveBedrockRouteConfig(
  env: NodeJS.ProcessEnv = process.env,
): BedrockRouteConfig | null {
  const raw = env.MATRIX_FUNDED_BEDROCK_ROUTE?.trim();
  if (!raw) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_ROUTE_CONFIG_BYTES) {
    throw new Error("Bedrock route configuration is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Bedrock route configuration is invalid");
    throw error;
  }
  const result = BedrockRouteConfigSchema.safeParse(parsed);
  if (!result.success) throw new Error("Bedrock route configuration is invalid");
  return result.data;
}
