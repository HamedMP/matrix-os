import { z } from "zod/v4";
import { ALIBABA_QWEN_37_PLUS_MODEL_ID, GOOGLE_GEMINI_38_FLASH_MODEL_ID, MOONSHOT_KIMI_K31_PRO_MODEL_ID } from "#funded-ai";

/** Immutable USD/M-token rates in thousandths of a microusd/token.
 * Each version records the review date against official Workers AI pricing.
 * https://developers.cloudflare.com/workers-ai/platform/pricing/
 * No rolling validity: each model still needs an explicit expiring attestation.
 */
export const WORKERS_AI_PRICE_SNAPSHOTS = Object.freeze({
  "@cf/zai-org/glm-5.3-flash": { prefix: "GLM", version: "cloudflare-2026-09-10-glm-flash", input: 150, output: 500, cached: 30 },
  "@cf/deepseek-ai/deepseek-v4-flash-0731": { prefix: "DEEPSEEK_FLASH", version: "cloudflare-2026-10-15-deepseek-v4-flash-0731", input: 440, output: 1320, cached: 14 },
  "@cf/zai-org/glm-5.3": { prefix: "GLM_FULL", version: "cloudflare-2026-10-15-glm-5.3", input: 1400, output: 4400, cached: 260 },
  "@cf/moonshotai/kimi-k2.7-code": { prefix: "KIMI_CODE", version: "cloudflare-2026-10-15-kimi-k2.7-code", input: 950, output: 4000, cached: 190 },
  "@cf/openai/gpt-oss-120b": { prefix: "GPT_OSS_120B", version: "cloudflare-2026-10-15-gpt-oss-120b", input: 350, output: 750, cached: 350 },
  "@cf/google/gemma-4-26b-a4b-it": { prefix: "GEMMA_4", version: "cloudflare-2026-10-15-gemma-4-26b", input: 100, output: 300, cached: 50 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { prefix: "DEEPSEEK_PRO", version: "cloudflare-2026-10-15-deepseek-v4-pro-0813", input: 1320, output: 3960, cached: 44 },
  "@cf/qwen/qwen3.8-27b": { prefix: "QWEN_38", version: "cloudflare-2026-10-15-qwen3.8-27b", input: 450, output: 3200, cached: 50 },
  "@cf/openai/gpt-oss-20b": { prefix: "GPT_OSS_20B", version: "cloudflare-2026-10-15-gpt-oss-20b", input: 200, output: 300, cached: 200 },
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": { prefix: "DEEPSEEK_V41_FLASH", version: "cloudflare-2026-11-12-deepseek-v4.1-flash-1017", input: 300, output: 1200, cached: 6 },
  "@cf/thinkingmachines/inkling-2-small": { prefix: "INKLING_2_SMALL", version: "cloudflare-2026-11-25-inkling-2-small", input: 300, output: 1000, cached: 100 },
} as const);
export type WorkersPricingModelId = keyof typeof WORKERS_AI_PRICE_SNAPSHOTS;
export const WORKERS_AI_PRICING_VERSIONS = Object.freeze(Object.fromEntries(
  Object.entries(WORKERS_AI_PRICE_SNAPSHOTS).map(([id, price]) => [id, price.version]),
) as { [K in WorkersPricingModelId]: typeof WORKERS_AI_PRICE_SNAPSHOTS[K]["version"] });

export const FUNDED_SONNET_5_PRICE = Object.freeze({
  version: "anthropic-2026-08-31-standard",
  input: 2_000,
  output: 10_000,
  cached: 200,
  cacheWrite5m: 2_500,
  cacheWrite1h: 4_000,
});

// The Cloudflare Chat Completions route uses implicit caching without an
// explicit cache resource or a separate cache creation charge.
// https://developers.cloudflare.com/ai/models/google/gemini-3.8-flash/
export const GOOGLE_GEMINI_38_FLASH_PRICE = Object.freeze({
  version: "cloudflare-2026-11-26-gemini-3.8-flash",
  rateExpiresAt: "2026-12-31T23:59:59.999Z",
  input: 750,
  output: 3750,
  cached: 75,
  cacheWrite5m: 750,
  cacheWrite1h: 750,
});

// Cloudflare's Moonshot route charges uncached input at the standard input rate.
// https://developers.cloudflare.com/ai/models/moonshotai/kimi-k3.1-pro/
export const MOONSHOT_KIMI_K31_PRO_PRICE = Object.freeze({
  version: "cloudflare-2026-11-26-kimi-k3.1-pro",
  input: 2000,
  output: 10000,
  cached: 200,
  cacheWrite5m: 2000,
  cacheWrite1h: 2000,
});

// https://developers.cloudflare.com/ai/models/alibaba/qwen3.7-plus/
export const ALIBABA_QWEN_37_PLUS_PRICE = Object.freeze({
  version: "cloudflare-2026-11-26-qwen3.7-plus",
  input: 320,
  output: 1280,
  cached: 64,
  cacheWrite5m: 320,
  cacheWrite1h: 320,
});

type FundedRate = {
  version: string;
  rateExpiresAt?: string;
  input: number;
  output: number;
  cached: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

export const FUNDED_PRICING_CATALOG: Readonly<Record<string, Readonly<FundedRate>>> = Object.freeze({
  ...Object.fromEntries(Object.entries(WORKERS_AI_PRICE_SNAPSHOTS).map(([modelId, rate]) => [
    modelId, Object.freeze({ ...rate, cacheWrite5m: rate.input, cacheWrite1h: rate.input }),
  ])),
  "anthropic/claude-sonnet-5": FUNDED_SONNET_5_PRICE,
  [GOOGLE_GEMINI_38_FLASH_MODEL_ID]: GOOGLE_GEMINI_38_FLASH_PRICE,
  [MOONSHOT_KIMI_K31_PRO_MODEL_ID]: MOONSHOT_KIMI_K31_PRO_PRICE,
  [ALIBABA_QWEN_37_PLUS_MODEL_ID]: ALIBABA_QWEN_37_PLUS_PRICE,
});

export const FUNDED_PRICING_REVIEW_MAX_MS = 31 * 24 * 60 * 60_000;

const CanonicalReviewTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  });

const PricingModelIdSchema = z.string().min(1).max(128).regex(/^[@a-zA-Z0-9/._-]+$/);
const PricingVersionSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/);

export const FundedAiPricingRouteFailureSchema = z.object({
  modelId: PricingModelIdSchema,
  version: PricingVersionSchema,
  observedAt: CanonicalReviewTimeSchema,
}).strict();

export const FundedAiPricingReviewSchema = z.object({
  modelId: PricingModelIdSchema,
  version: PricingVersionSchema,
  reviewedAt: CanonicalReviewTimeSchema,
  validThrough: CanonicalReviewTimeSchema,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  blockedAt: CanonicalReviewTimeSchema.nullable(),
}).strict().refine(value => {
  const windowMs = Date.parse(value.validThrough) - Date.parse(value.reviewedAt);
  return windowMs > 0 && windowMs <= FUNDED_PRICING_REVIEW_MAX_MS
    || windowMs === 0 && value.blockedAt !== null && value.blockedAt <= value.reviewedAt;
}, { message: "Invalid funded pricing review window" });

export const FundedAiPricingReviewSnapshotSchema = z.object({
  contractVersion: z.literal(1),
  reviews: z.array(FundedAiPricingReviewSchema).max(64),
}).strict().refine(value => new Set(value.reviews.map(review => review.modelId)).size === value.reviews.length,
  { message: "Duplicate funded pricing review model" });

export type FundedAiPricingReview = z.infer<typeof FundedAiPricingReviewSchema>;

export function currentFundedAiPricingReview(review: FundedAiPricingReview, at: Date): boolean {
  const price = Object.hasOwn(FUNDED_PRICING_CATALOG, review.modelId) ? FUNDED_PRICING_CATALOG[review.modelId] : undefined;
  const time = at.getTime();
  return price?.version === review.version && Date.parse(review.reviewedAt) <= time
    && (!price.rateExpiresAt || review.validThrough <= price.rateExpiresAt)
    && Date.parse(review.validThrough) > time
    && (review.blockedAt === null || Date.parse(review.blockedAt) > time);
}
