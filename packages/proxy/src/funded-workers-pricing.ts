/** Immutable USD/M-token rates in thousandths of a microusd/token.
 * Reviewed 2026-10-15 against official Workers AI pricing and account catalog.
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
} as const);
export type WorkersPricingModelId = keyof typeof WORKERS_AI_PRICE_SNAPSHOTS;
export const WORKERS_AI_PRICING_VERSIONS = Object.freeze(Object.fromEntries(
  Object.entries(WORKERS_AI_PRICE_SNAPSHOTS).map(([id, price]) => [id, price.version]),
) as { [K in WorkersPricingModelId]: typeof WORKERS_AI_PRICE_SNAPSHOTS[K]["version"] });
