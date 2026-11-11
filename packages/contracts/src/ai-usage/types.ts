export type UsageAgent = "claude" | "codex";
/** Content-free telemetry. Input excludes the disjoint cache counters. */
export interface UsageEvent {
  id: string;
  session: string;
  agent: UsageAgent;
  model: string;
  timestamp: string;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  sourceKind?: "response" | "cumulative";
  cumulative?: { input: number; cached: number; output: number };
}
export interface UsageParseResult {
  events: UsageEvent[];
  issues: number;
}
export interface UsageTotals {
  tokens: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  requests: number;
  estimatedUsd: number | null;
  unpriced: number;
}
export interface UsageSummary extends UsageTotals {
  sessions: number;
  activeDays: number;
  daily: Array<UsageTotals & { day: string }>;
  models: Array<UsageTotals & { agent: UsageAgent; model: string }>;
}
export const MAX_USAGE_EVENTS = 100_000;
export const MAX_USAGE_FILES = 2_000;
export const MAX_USAGE_FILE_BYTES = 64 * 1024 * 1024;
