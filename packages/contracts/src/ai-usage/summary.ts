import { mergeUsageEvents } from "./parser.js";
import { reconcileUsageEvents } from "./reconcile.js";
import type {
  UsageAgent,
  UsageEvent,
  UsageSummary,
  UsageTotals,
} from "./types.js";
/** USD / million tokens. Reviewed 2026-11-09; intentionally exact model allowlist.
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://developers.openai.com/api/docs/pricing
 * Cache writes without TTL and long-context/service-tier surcharges remain unpriced.
 */
const prices: Record<string, readonly [number, number, number]> = {
  "claude-sonnet-4-20250514": [3, 0.3, 15],
  "claude-sonnet-4-5-20250929": [3, 0.3, 15],
  "claude-sonnet-4-6": [3, 0.3, 15],
  "claude-opus-4-6": [5, 0.5, 25],
  "claude-opus-4-5-20251101": [5, 0.5, 25],
  "claude-opus-5": [5, 0.5, 25],
  "gpt-5.3-codex": [1.75, 0.175, 14],
  "gpt-5": [1.25, 0.125, 10],
  "gpt-5.4": [2.5, 0.25, 15],
  "gpt-5.5": [5, 0.5, 30],
  "gpt-6.1-sol": [2, 0.1, 10],
  "claude-sonnet-5-5": [2, 0.1, 10],
  "claude-opus-5-5": [4, 0.2, 20],
  "claude-opus-4-8": [5, 0.5, 25],
  "claude-fable-5-1": [10, 0.25, 50],
  "gpt-5.6-sol": [4, 0.4, 20],
};
export const PRICING_VERSION = "api-list-2026-11-09-poc";
export function estimateUsageUsd(e: UsageEvent): number | null {
  const p = prices[e.model];
  if (!p || e.input + e.cachedInput + e.cacheWrite > 200_000) return null;
  const short = e.cacheWrite5m ?? 0,
    long = e.cacheWrite1h ?? 0;
  if (short + long !== e.cacheWrite) return null;
  return (
    (e.input * p[0] +
      e.cachedInput * p[1] +
      e.output * p[2] +
      short * p[0] * 1.25 +
      long * p[0] * 2) /
    1e6
  );
}
/** Constructing a formatter costs far more than using one; a report formats every event. */
export function usageDayFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (timestamp: string) => {
    const parts = formatter.formatToParts(new Date(timestamp));
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
}
export function usageDay(timestamp: string, timeZone: string): string {
  return usageDayFormatter(timeZone)(timestamp);
}
export function shiftUsageDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400000)
    .toISOString()
    .slice(0, 10);
}
const empty = (): UsageTotals => ({
  tokens: 0,
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  requests: 0,
  estimatedUsd: null,
  unpriced: 0,
});
function add(t: UsageTotals, e: UsageEvent) {
  t.input += e.input;
  t.cachedInput += e.cachedInput;
  t.cacheWrite += e.cacheWrite;
  t.output += e.output;
  t.tokens += e.input + e.cachedInput + e.cacheWrite + e.output;
  t.requests++;
  const price = estimateUsageUsd(e);
  if (price === null) t.unpriced++;
  else t.estimatedUsd = (t.estimatedUsd ?? 0) + price;
}
export function summarizeUsage(
  events: UsageEvent[],
  options: {
    timeZone: string;
    endDay: string;
    days: number;
    agent?: UsageAgent;
  },
): UsageSummary {
  if (
    !Number.isInteger(options.days) ||
    options.days < 1 ||
    options.days > 366 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.endDay)
  )
    throw new RangeError("Invalid usage range");
  const daily = Array.from({ length: options.days }, (_, i) => ({
    day: shiftUsageDay(options.endDay, i - options.days + 1),
    ...empty(),
  }));
  const models: UsageSummary["models"] = [],
    sessions = new Set<string>(); // Per-call, capped by MAX_USAGE_EVENTS and discarded on return.
  const byDay = new Map(daily.map((day) => [day.day, day]));
  const byModel = new Map<string, UsageSummary["models"][number]>(); // Same event cap.
  const dayOf = usageDayFormatter(options.timeZone);
  const total: UsageSummary = {
    ...empty(),
    daily,
    models,
    sessions: 0,
    activeDays: 0,
  };
  for (const e of reconcileUsageEvents(mergeUsageEvents(events).events).events) {
    if (options.agent && options.agent !== e.agent) continue;
    const bucket = byDay.get(dayOf(e.timestamp));
    if (!bucket) continue;
    add(total, e);
    add(bucket, e);
    const modelKey = `${e.agent}:${e.model}`;
    let row = byModel.get(modelKey);
    if (!row) {
      row = { ...empty(), agent: e.agent, model: e.model };
      models.push(row);
      byModel.set(modelKey, row);
    }
    add(row, e);
    const session = `${e.agent}:${e.session}`;
    sessions.add(session);
  }
  total.sessions = sessions.size;
  total.activeDays = daily.filter((d) => d.requests > 0).length;
  models.sort((a, b) => b.tokens - a.tokens);
  return total;
}
