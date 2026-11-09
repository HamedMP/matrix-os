import { estimateUsageUsd, shiftUsageDay, usageDay } from "./summary.js";
import type {
  UsageAgent,
  UsageEvent,
  UsageSummary,
  UsageTotals,
} from "./types.js";
export interface UsageHistoryReport {
  id: string;
  label: string;
  agent: UsageAgent | "";
  endDay: string;
  days: number;
  summary: UsageSummary;
}
export interface UsageHistoryCoverage {
  machines: string[];
  files: number;
  bytes: number;
  indexedBytes: number;
  oldest: string | null;
  newest: string | null;
  issues: number;
  failedRoots: number;
  indexedAt: string;
  indexing?: boolean;
  oldestActivity?: string | null;
  activityOnlySessions?: number;
  backup?: { verifiedFiles: number; verifiedBytes: number; verifiedAt: string };
  preservedAgents?: string[];
  webHistory?: {
    provider: string;
    conversations: number;
    messages: number;
    first: string | null;
    last: string | null;
    years: Array<{ year: string; conversations: number; messages: number }>;
    tokenCountersAvailable: false;
  };
  legacyActivity?: {
    firstDay: string;
    lastDay: string;
    days: number;
    sessions: number;
    label: string;
  };
}
export interface UsageHistory {
  timeZone?: string;
  reports: UsageHistoryReport[];
  coverage: UsageHistoryCoverage;
}
const totals = (): UsageTotals => ({
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
  const p = estimateUsageUsd(e);
  if (p === null) t.unpriced++;
  else t.estimatedUsd = (t.estimatedUsd ?? 0) + p;
}
/** Receives canonical events grouped by agent/session. Memory scales with reporting days/models, never event count. */
export function createHistoryReports(
  oldest: string | null,
  zone = "UTC",
  now = new Date(),
) {
  const endDay = usageDay(now.toISOString(), zone),
    first = oldest ? usageDay(oldest, zone) : endDay;
  const oldestYear = Math.max(2000, Number(first.slice(0, 4))),
    year = Number(endDay.slice(0, 4));
  const ranges = [
    { id: "all", label: "All available history", start: first, end: endDay },
    ...[7, 30, 90, 365].map((d) => ({
      id: String(d),
      label: d === 365 ? "Last year" : `Last ${d} days`,
      start: shiftUsageDay(endDay, 1 - d),
      end: endDay,
    })),
    ...Array.from({ length: Math.max(0, year - oldestYear + 1) }, (_, i) => ({
      id: `year:${oldestYear + i}`,
      label: String(oldestYear + i),
      start: `${oldestYear + i}-01-01`,
      end: oldestYear + i === year ? endDay : `${oldestYear + i}-12-31`,
    })),
  ];
  const reports: UsageHistoryReport[] = [],
    states: Array<{
      report: UsageHistoryReport;
      start: string;
      byDay: Map<string, UsageTotals & { day: string }>;
      models: Map<string, UsageSummary["models"][number]>;
      lastSession: string;
    }> = [];
  for (const range of ranges)
    for (const agent of ["", "claude", "codex"] as const) {
      const days =
        Math.round(
          (Date.parse(range.end) - Date.parse(range.start)) / 86400000,
        ) + 1;
      if (days < 1 || days > 20000)
        throw new RangeError("Unsupported history dates");
      const daily = Array.from({ length: days }, (_, i) => ({
        day: shiftUsageDay(range.start, i),
        ...totals(),
      }));
      const report = {
        id: range.id,
        label: range.label,
        agent,
        endDay: range.end,
        days,
        summary: { ...totals(), daily, models: [], sessions: 0, activeDays: 0 },
      };
      reports.push(report);
      states.push({
        report,
        start: range.start,
        byDay: new Map(daily.map((d) => [d.day, d])),
        models: new Map(),
        lastSession: "",
      });
    }
  return {
    push(e: UsageEvent) {
      const day = usageDay(e.timestamp, zone);
      for (const state of states) {
        const { report } = state;
        if (
          (report.agent && report.agent !== e.agent) ||
          day < state.start ||
          day > report.endDay
        )
          continue;
        const bucket = state.byDay.get(day);
        if (!bucket) continue;
        add(report.summary, e);
        add(bucket, e);
        const key = `${e.agent}:${e.model}`;
        let model = state.models.get(key);
        if (!model) {
          if (state.models.size >= 10000)
            throw new RangeError("Usage model limit");
          model = { ...totals(), agent: e.agent, model: e.model };
          state.models.set(key, model);
          report.summary.models.push(model);
        }
        add(model, e);
        const session = `${e.agent}:${e.session}`;
        if (state.lastSession !== session) {
          report.summary.sessions++;
          state.lastSession = session;
        }
      }
    },
    finish() {
      for (const { report } of states) {
        report.summary.activeDays = report.summary.daily.filter(
          (d) => d.requests > 0,
        ).length;
        report.summary.models.sort((a, b) => b.tokens - a.tokens);
      }
      return reports;
    },
  };
}
