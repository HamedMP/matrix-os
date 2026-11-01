/**
 * Company Brain model claims: token prices and the usage of one Messages API response. Rates are tenths of a micro-USD
 * per token so the arithmetic stays integral; the cost is rounded up once per response, never under-counted.
 */
import type {
  BrainModelPrice, BrainModelTokenCounts, BrainModelUsage, BrainModelUsageReport,
} from "./types.js";

/**
 * Claude Opus 5.5: $4 input, $20 output, $0.20 cache read and $5 5-minute cache write per million tokens. The
 * `fallbacks: "default"` targets (Claude Opus 5, Claude Opus 4.8): $5 / $25, reads at 0.1x and 5-minute writes at
 * 1.25x ($6.25, rounded up). Only the 5-minute TTL is ever sent, so every cache write is priced at that rate.
 */
export const BRAIN_MODEL_PRICES: Readonly<Record<string, BrainModelPrice>> = {
  "claude-opus-5-5": { input: 40, output: 200, cacheRead: 2, cacheWrite: 50 },
  "claude-opus-5": { input: 50, output: 250, cacheRead: 5, cacheWrite: 63 },
  "claude-opus-4-8": { input: 50, output: 250, cacheRead: 5, cacheWrite: 63 },
};

const prices = Object.values(BRAIN_MODEL_PRICES);
/** A model missing from the table is priced at the highest rate of each field. */
const UNKNOWN_MODEL_PRICE: BrainModelPrice = {
  input: Math.max(...prices.map((price) => price.input)),
  output: Math.max(...prices.map((price) => price.output)),
  cacheRead: Math.max(...prices.map((price) => price.cacheRead)),
  cacheWrite: Math.max(...prices.map((price) => price.cacheWrite)),
};

export function brainModelPrice(model: string): BrainModelPrice {
  return Object.hasOwn(BRAIN_MODEL_PRICES, model) ? BRAIN_MODEL_PRICES[model] : UNKNOWN_MODEL_PRICE;
}

interface Attempt { readonly counts: BrainModelTokenCounts; readonly model: string }

/**
 * Sums every billed attempt. `iterations`, when non-empty, is the per-attempt source of truth (a declined attempt plus
 * the fallback attempt, each at its own model's rates); otherwise the top-level counts are one attempt at
 * requestedModel. inputTokens counts uncached input, cache reads and cache writes.
 */
export function brainModelUsage(report: BrainModelUsageReport, requestedModel: string): BrainModelUsage {
  const attempts: readonly Attempt[] = report.iterations !== null && report.iterations.length > 0
    ? report.iterations.map((entry) => ({ counts: entry, model: entry.model ?? requestedModel }))
    : [{ counts: report, model: requestedModel }];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let tenths = 0;
  for (const { counts, model } of attempts) {
    const price = brainModelPrice(model);
    const read = counts.cache_read_input_tokens ?? 0;
    const write = counts.cache_creation_input_tokens ?? 0;
    inputTokens += counts.input_tokens + read + write;
    outputTokens += counts.output_tokens;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    tenths += counts.input_tokens * price.input + counts.output_tokens * price.output
      + read * price.cacheRead + write * price.cacheWrite;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicroUsd: Math.ceil(tenths / 10) };
}
