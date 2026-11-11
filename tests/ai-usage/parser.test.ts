import { describe, expect, it } from "vitest";
import {
  parseUsageRecords,
  summarizeUsage,
  mergeUsageEvents,
} from "../../packages/contracts/src/ai-usage/index";
const time = "2026-11-09T23:30:00Z";
const claude = (output = 20) => ({
  type: "assistant",
  timestamp: time,
  sessionId: "s1",
  requestId: "r1",
  message: {
    id: "m1",
    model: "claude-sonnet-4-20250514",
    usage: {
      input_tokens: 100,
      output_tokens: output,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    },
  },
});
const codex = (input: number, output: number) => ({
  type: "event_msg",
  timestamp: time,
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: 40,
        output_tokens: output,
        reasoning_output_tokens: 5,
      },
      last_token_usage: { input_tokens: input, output_tokens: output },
    },
  },
});
describe("personal usage accounting", () => {
  it("uses the completed Claude streaming response once, including disjoint cache categories", () => {
    const parsed = parseUsageRecords(
      "claude",
      [claude(10), claude(20)],
      "file1",
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      input: 100,
      cachedInput: 50,
      cacheWrite: 10,
      output: 20,
    });
    expect(
      summarizeUsage(parsed.events, {
        timeZone: "Europe/Stockholm",
        endDay: "2026-11-10",
        days: 7,
      }).tokens,
    ).toBe(180);
  });
  it("counts Codex cumulative deltas, ignores repeated totals, and does not add reasoning twice", () => {
    const p = parseUsageRecords(
      "codex",
      [
        { type: "session_meta", payload: { id: "c1" } },
        { type: "turn_context", payload: { model: "gpt-5" } },
        codex(100, 10),
        codex(100, 10),
        codex(150, 25),
      ],
      "f",
    );
    expect(p.events).toHaveLength(2);
    const s = summarizeUsage(p.events, {
      timeZone: "UTC",
      endDay: "2026-11-09",
      days: 1,
    });
    expect(s.tokens).toBe(175);
    expect(s.output).toBe(25);
    expect(s.cachedInput).toBe(40);
  });
  it("deduplicates the same source imported twice and keeps independent sessions", () => {
    const a = parseUsageRecords("claude", [claude()], "a");
    const b = parseUsageRecords("claude", [claude()], "b");
    expect(mergeUsageEvents([...a.events, ...b.events]).events).toHaveLength(1);
    expect(
      mergeUsageEvents([...a.events, { ...b.events[0], id: "other" }]).events,
    ).toHaveLength(2);
    expect(
      mergeUsageEvents([...a.events, { ...b.events[0], output: 999 }])
        .conflicts,
    ).toBe(1);
  });
  it("keeps unknown prices unavailable and reports a priced subtotal separately", () => {
    const e = parseUsageRecords(
      "claude",
      [
        {
          ...claude(),
          message: { ...claude().message, model: "future-model" },
        },
      ],
      "f",
    ).events;
    const s = summarizeUsage(e, {
      timeZone: "UTC",
      endDay: "2026-11-09",
      days: 7,
    });
    expect(s.estimatedUsd).toBeNull();
    expect(s.unpriced).toBe(1);
    expect(s.tokens).toBe(180);
  });
  it("buckets by reporting civil day and applies agent/range filters to all totals", () => {
    const e = parseUsageRecords("claude", [claude()], "f").events;
    expect(
      summarizeUsage(e, {
        timeZone: "Europe/Stockholm",
        endDay: "2026-11-10",
        days: 1,
      }).daily[0].day,
    ).toBe("2026-11-10");
    expect(
      summarizeUsage(e, { timeZone: "UTC", endDay: "2026-11-10", days: 1 })
        .tokens,
    ).toBe(0);
    expect(
      summarizeUsage(e, {
        timeZone: "UTC",
        endDay: "2026-11-09",
        days: 1,
        agent: "codex",
      }).tokens,
    ).toBe(0);
  });
  it("rejects bad telemetry and flags cumulative resets instead of fabricating usage", () => {
    expect(
      parseUsageRecords("claude", [claude(-1)], "f").issues,
    ).toBeGreaterThan(0);
    const p = parseUsageRecords("codex", [codex(100, 20), codex(50, 10)], "f");
    expect(p.issues).toBeGreaterThan(0);
    expect(p.events).toHaveLength(1);
  });
});
it("prices known Claude cache TTLs and standard Codex models without assuming unknown writes", () => {
  const record = claude();
  record.message.model = "claude-opus-5-5";
  const usage = {
    ...record.message.usage,
    cache_creation: {
      ephemeral_5m_input_tokens: 4,
      ephemeral_1h_input_tokens: 6,
    },
  };
  const p = parseUsageRecords(
    "claude",
    [{ ...record, message: { ...record.message, usage } }],
    "f",
  );
  const s = summarizeUsage(p.events, {
    timeZone: "UTC",
    endDay: "2026-11-09",
    days: 1,
  });
  expect(s.estimatedUsd).toBeCloseTo(
    (100 * 4 + 50 * 0.2 + 20 * 20 + 4 * 5 + 6 * 8) / 1e6,
  );
});
it("does not count synthetic zero-token messages or missing counters as usage", () => {
  expect(
    parseUsageRecords(
      "claude",
      [{ ...claude(), message: { id: "m", usage: {}, model: "synthetic" } }],
      "f",
    ),
  ).toMatchObject({ events: [] });
});
