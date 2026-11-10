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
function uncovered(start: number, end: number, covered: Range[]) {
  let remaining = end - start;
  for (const [from, to] of covered)
    remaining -= Math.max(0, Math.min(end, to) - Math.max(start, from));
  return remaining;
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
    const ranges = { input: union(covered.input), cached: union(covered.cached), output: union(covered.output) };
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
      const input = uncovered(start.input, next.input, ranges.input),
        cached = uncovered(start.cached, next.cached, ranges.cached),
        output = uncovered(start.output, next.output, ranges.output);
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
