// Anthropic pricing per million tokens (USD)
// Update when Anthropic changes pricing
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':         { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-5':       { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':        { input: 0.8, output: 4,   cacheRead: 0.08, cacheWrite: 1 },
};

const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4-6-20250923': 'claude-opus-4-6',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
};

function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function calculateCost(usage: TokenUsage): number {
  const pricing = PRICING[resolveModel(usage.model)];
  if (!pricing) return 0;

  const cost =
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheWriteTokens * pricing.cacheWrite) /
    1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}
