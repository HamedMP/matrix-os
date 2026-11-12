import { expect, it, vi } from "vitest";
import {
  createHistoryReports,
  parseUsageRecords,
  reconcileUsageEvents,
  summarizeUsage,
} from "../../packages/contracts/src/ai-usage/index";
const meta = {
  type: "session_meta",
  timestamp: "2026-11-01T10:00:00Z",
  payload: { id: "thread" },
};
const model = {
  type: "turn_context",
  timestamp: "2026-11-01T10:00:00Z",
  payload: { model: "gpt-5.5" },
};
const total = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
});
const native = (
  id: string,
  usage: [number, number, number],
  thread?: [number, number, number],
) => ({
  type: "token_usage_record",
  timestamp: "2026-11-01T10:00:02Z",
  payload: {
    response_id: id,
    thread_id: "thread",
    usage: total(...usage),
    thread_token_usage: thread ? total(...thread) : undefined,
  },
});
const legacy = (input: number, cached: number, output: number) => ({
  type: "event_msg",
  timestamp: "2026-11-01T10:00:03Z",
  payload: {
    type: "token_count",
    info: { total_token_usage: total(input, cached, output) },
  },
});
const tokens = (records: unknown[]) =>
  summarizeUsage(parseUsageRecords("codex", records, "file").events, {
    timeZone: "UTC",
    endDay: "2026-11-01",
    days: 1,
  }).tokens;

it("counts a Codex request once when the legacy counter drifts from the native thread total", () => {
  // Real sessions: the cumulative mirror lags the native thread total after the first requests.
  const records = [
    meta,
    model,
    native("r1", [1000, 200, 50], [1000, 200, 50]),
    legacy(1000, 200, 50),
    native("r2", [2000, 1000, 80], [3000, 1200, 130]),
    legacy(2900, 1150, 120),
    native("r3", [500, 400, 20], [3500, 1600, 150]),
    legacy(3400, 1550, 140),
  ];
  expect(tokens(records)).toBe(3500 + 150);
  expect(tokens([meta, model, legacy(1000, 200, 50), native("r1", [1000, 200, 50], [1000, 200, 50])])).toBe(1050);
});

it("keeps legacy usage that precedes native records and leaves its model unpriced", () => {
  const events = parseUsageRecords(
    "codex",
    [
      meta,
      model,
      legacy(400, 100, 40),
      native("r1", [600, 300, 10], [1000, 400, 50]),
      legacy(1000, 400, 50),
    ],
    "file",
  ).events;
  const result = reconcileUsageEvents(events);
  expect(result.dropped).toBe(0);
  expect(
    result.events.map((e) => [e.sourceKind, e.model, e.input + e.cachedInput + e.output]),
  ).toEqual([
    ["cumulative", "unknown", 440],
    ["response", "gpt-5.5", 610],
  ]);
});

it("reports legacy counters as incomplete when native records cannot locate them", () => {
  const events = parseUsageRecords(
    "codex",
    [meta, model, native("r1", [1000, 200, 50]), legacy(1000, 200, 50)],
    "file",
  ).events;
  const result = reconcileUsageEvents(events);
  expect(result.dropped).toBe(1);
  expect(result.events.map((e) => e.sourceKind)).toEqual(["response"]);
});

it("leaves sessions with only cumulative counters and other agents untouched", () => {
  const events = parseUsageRecords(
    "codex",
    [meta, model, legacy(100, 0, 10), legacy(300, 100, 30)],
    "file",
  ).events;
  expect(reconcileUsageEvents(events)).toEqual({ events, dropped: 0 });
});

it("rejects timestamps the history database cannot order", () => {
  const record = (timestamp: string) => ({
    type: "assistant",
    timestamp,
    sessionId: "s",
    message: { id: "m" + timestamp, model: "unknown", usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const parsed = parseUsageRecords(
    "claude",
    [record("2026-11-01T10:00:00.123Z"), record("2026-11-01T10:00:00+01:00"), record("Nov 1, 2026 10:00"), record("2026-11-01")],
    "file",
  );
  expect(parsed.events).toHaveLength(2);
  expect(parsed.issues).toBe(2);
});

it("builds a large report with one date formatter and counts events outside its range", () => {
  const Original = Intl.DateTimeFormat;
  let constructed = 0;
  vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: class extends Original { constructor(...args: ConstructorParameters<typeof Original>) { super(...args); constructed++; } } });
  const builder = createHistoryReports("2026-10-01T00:00:00Z", "Europe/Stockholm", new Date("2026-11-10T12:00:00Z"));
  const before = constructed;
  const event = (timestamp: string, id: string) => ({
    id, session: "s", agent: "claude" as const, model: "unknown", timestamp, input: 1, cachedInput: 0, cacheWrite: 0, output: 1,
  });
  for (let i = 0; i < 2000; i++)
    builder.push(event(new Date(Date.parse("2026-10-02T00:00:00Z") + i * 60_000).toISOString(), "e" + i));
  builder.push(event("2026-09-01T00:00:00Z", "early"));
  builder.push(event("2027-01-01T00:00:00Z", "future"));
  vi.unstubAllGlobals();
  expect(constructed - before).toBe(0);
  expect(builder.outsideRange()).toBe(2);
  expect(builder.finish().find((r) => r.id === "all" && r.agent === "")?.summary.tokens).toBe(4000);
});

it("rebuilds cumulative-only sessions from the counters, like the history index, when files overlap", () => {
  const file = (source: string, input: number, output: number) =>
    parseUsageRecords("codex", [meta, model, legacy(input, 0, output)], source).events;
  // The same session recorded in two files: each file's own delta starts from zero.
  const events = [...file("a", 1000, 100), ...file("b", 1500, 150)];
  expect(events.reduce((n, e) => n + e.input + e.output, 0)).toBe(2750);
  const result = reconcileUsageEvents(events);
  expect(result.events.reduce((n, e) => n + e.input + e.output, 0)).toBe(1650);
  expect(result.events.every((e) => e.model === "gpt-5.5")).toBe(true);
});

it("reconciles a long session with gaps between native records without rescanning every range", () => {
  // Every other request lost its native record, so native ranges cannot merge into one.
  const events = [];
  const count = 20_000;
  for (let i = 1; i <= count; i++) {
    const cumulative = { input: i * 100, cached: 0, output: i * 10 };
    const base = { session: "long", agent: "codex" as const, model: "gpt-5.5", timestamp: new Date(1.78e12 + i * 1000).toISOString(), input: 100, cachedInput: 0, cacheWrite: 0, output: 10, cumulative };
    events.push({ ...base, id: `legacy:${i}`, sourceKind: "cumulative" as const });
    if (i % 2) events.push({ ...base, id: `native:${i}`, sourceKind: "response" as const });
  }
  const started = performance.now();
  const result = reconcileUsageEvents(events);
  expect(performance.now() - started).toBeLessThan(1500);
  expect(result.dropped).toBe(0);
  expect(result.events.reduce((n, e) => n + e.input + e.output, 0)).toBe(count * 110);
});
