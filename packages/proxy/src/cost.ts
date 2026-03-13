// Anthropic pricing per million tokens (USD)
// https://platform.claude.com/docs/en/about-claude/pricing
// Updated 2026-03-11
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':         { input: 5,   output: 25,  cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5':         { input: 5,   output: 25,  cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-6':       { input: 3,   output: 15,  cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5':       { input: 3,   output: 15,  cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5':        { input: 1,   output: 5,   cacheRead: 0.10, cacheWrite: 1.25 },
};

const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4-6-20250923': 'claude-opus-4-6',
  'claude-opus-4-5-20250514': 'claude-opus-4-5',
  'claude-sonnet-4-6-20250827': 'claude-sonnet-4-6',
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
