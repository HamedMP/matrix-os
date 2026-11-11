import type { UsageEvent } from "./types.js";
type Range = [number, number];
type Counters = { input: number; cached: number; output: number };
const fields = ["input", "cached", "output"] as const;
function union(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
/** Prefix totals over merged ranges, so each lookup is a binary search rather than a scan of every range. */
function coverage(ranges: Range[]) {
  const merged = union(ranges),
    before: number[] = [];
  let total = 0;
  for (const [start, end] of merged) {
    before.push(total);
    total += end - start;
  }
  const below = (value: number) => {
    let low = 0,
      high = merged.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((merged[middle] as Range)[0] < value) low = middle + 1;
      else high = middle;
    }
    if (!low) return 0;
    const [start, end] = merged[low - 1] as Range;
    return (before[low - 1] as number) + Math.min(value, end) - start;
  };
  return (start: number, end: number) => end - start - (below(end) - below(start));
}
/** Codex writes each request twice: a native per-response record and a cumulative counter that can drift from it.
 * Subtract the counter ranges the native records already cover, matching canonicalHistoryQuery in the gateway.
 * Counters that cannot be located against native records are dropped and counted, never added. */
export function reconcileUsageEvents(events: UsageEvent[]) {
  const sessions = new Map<string, { native: UsageEvent[]; legacy: UsageEvent[] }>(); // Per call; bounded by the caller's event cap.
  for (const event of events) {
    if (event.agent !== "codex" || !event.sourceKind) continue;
    let session = sessions.get(event.session);
    if (!session) sessions.set(event.session, (session = { native: [], legacy: [] }));
    (event.sourceKind === "response" ? session.native : session.legacy).push(event);
  }
  const replaced = new Map<UsageEvent, UsageEvent | null>(); // Same bound; released on return.
  let dropped = 0;
  for (const { native, legacy } of sessions.values()) {
    // Without native records nothing is subtracted, but deltas are still rebuilt from the counters:
    // a session copied into two files otherwise contributes each file's delta from zero.
    if (!legacy.length) continue;
    const covered: Record<keyof Counters, Range[]> = { input: [], cached: [], output: [] };
    let uncertain = false;
    const prior: Counters = { input: 0, cached: 0, output: 0 };
    native.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.id < b.id ? -1 : 1));
    for (const event of native) {
      const total = event.cumulative,
        actual: Counters = {
          input: event.input + event.cachedInput + event.cacheWrite,
          cached: event.cachedInput,
          output: event.output,
        };
      if (!total) {
        uncertain = true;
        break;
      }
      for (const field of fields) {
        const start = total[field] - actual[field];
        if (start < 0 || start < prior[field]) uncertain = true;
        covered[field].push([start, total[field]]);
        prior[field] = total[field];
      }
    }
    if (uncertain) {
      for (const event of legacy) replaced.set(event, null);
      dropped += legacy.length;
      continue;
    }
    const uncovered = { input: coverage(covered.input), cached: coverage(covered.cached), output: coverage(covered.output) };
    const total = (e: UsageEvent) => e.cumulative ?? { input: 0, cached: 0, output: 0 };
    legacy.sort((a, b) => {
      const x = total(a), y = total(b);
      return x.input + x.output - (y.input + y.output) || x.input - y.input || x.cached - y.cached || (a.id < b.id ? -1 : 1);
    });
    let previous: Counters = { input: 0, cached: 0, output: 0 };
    for (const event of legacy) {
      const next = total(event), start = previous;
      previous = next;
      if (!event.cumulative || fields.some((field) => next[field] < start[field])) {
        replaced.set(event, null);
        dropped++;
        continue;
      }
      const input = uncovered.input(start.input, next.input),
        cached = uncovered.cached(start.cached, next.cached),
        output = uncovered.output(start.output, next.output);
      if (input < cached) {
        replaced.set(event, null);
        dropped++;
      } else if (input + output === 0) replaced.set(event, null);
      else
        replaced.set(event, { ...event, model: native.length ? "unknown" : event.model, input: input - cached, cachedInput: cached, cacheWrite: 0, output });
    }
  }
  if (!replaced.size) return { events, dropped };
  const result: UsageEvent[] = [];
  for (const event of events) {
    const value = replaced.get(event);
    if (value === undefined) result.push(event);
    else if (value) result.push(value);
  }
  return { events: result, dropped };
}
