import { expect, it } from "vitest";
import { streamUsageSource } from "../../packages/contracts/src/ai-usage/stream";
const row = (input: number, output: number) => ({
  type: "event_msg",
  timestamp: "2025-08-09T12:00:00Z",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: output,
      },
    },
  },
});
async function* bytes(value: string) {
  yield Buffer.from(value);
}
it("resumes at committed newline bytes with Codex cumulative state and retries an incomplete tail", async () => {
  const head =
    JSON.stringify({
      type: "session_meta",
      payload: { id: "native-session" },
    }) +
    "\n" +
    JSON.stringify(row(100, 10)) +
    "\n";
  const first = [];
  for await (const batch of streamUsageSource(
    bytes(head + '{"type":'),
    "source",
    { agent: "codex", batchRecords: 1 },
  ))
    first.push(batch);
  const checkpoint = first.at(-1)!;
  expect(checkpoint.offset).toBe(Buffer.byteLength(head));
  expect(checkpoint.issues).toBe(1);
  const resumed = [];
  for await (const batch of streamUsageSource(
    bytes(JSON.stringify(row(150, 25)) + "\n"),
    "source",
    { agent: "codex", offset: checkpoint.offset, state: checkpoint.state },
  ))
    resumed.push(...batch.events);
  expect(resumed[0]).toMatchObject({
    session: "native-session",
    input: 50,
    output: 15,
    cumulative: { input: 150, cached: 0, output: 25 },
  });
});
it("streams a source larger than the old 64 MiB cap without retaining transcript content", async () => {
  async function* large() {
    const padding = Buffer.from(
      JSON.stringify({ type: "user", content: "x".repeat(1024 * 1024) }) + "\n",
    );
    for (let i = 0; i < 65; i++) yield padding;
    yield Buffer.from(
      JSON.stringify({
        type: "assistant",
        timestamp: "2025-01-01T00:00:00Z",
        sessionId: "s",
        message: {
          id: "m",
          model: "unknown",
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      }) + "\n",
    );
  }
  let count = 0,
    offset = 0;
  for await (const batch of streamUsageSource(large(), "large", {
    agent: "claude",
    batchRecords: 8,
  })) {
    count += batch.events.length;
    offset = batch.offset;
    expect(JSON.stringify(batch)).not.toContain("xxxx");
  }
  expect(count).toBe(1);
  expect(offset).toBeGreaterThan(64 * 1024 * 1024);
});
import { createHistoryReports } from "../../packages/contracts/src/ai-usage/history-report";
it("reports all available years without loading every event into a browser", () => {
  const builder = createHistoryReports(
    "2023-01-01T00:00:00Z",
    "UTC",
    new Date("2026-11-09T00:00:00Z"),
  );
  for (const [session, timestamp] of [
    ["old", "2023-01-01T12:00:00Z"],
    ["recent", "2026-11-09T12:00:00Z"],
  ])
    builder.push({
      id: session,
      session,
      agent: "claude",
      model: "unknown",
      timestamp,
      input: 2,
      cachedInput: 0,
      cacheWrite: 0,
      output: 3,
    });
  const reports = builder.finish();
  expect(
    reports.find((r) => r.id === "all" && r.agent === "")?.summary,
  ).toMatchObject({ tokens: 10, sessions: 2, activeDays: 2 });
  expect(
    reports.find((r) => r.id === "year:2023" && r.agent === "claude")?.summary
      .tokens,
  ).toBe(5);
  expect(
    reports.find((r) => r.id === "30" && r.agent === "")?.summary.tokens,
  ).toBe(5);
});
it("counts modern native token records once beside cumulative mirrors", async () => {
  const records = [
    { type: "session_meta", payload: { id: "native-session" } },
    {
      type: "token_usage_record",
      timestamp: "2025-08-09T12:00:00Z",
      payload: {
        thread_id: "native-session",
        response_id: "response",
        thread_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 10,
        },
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
      },
    },
    row(100, 10),
  ];
  const events = [];
  for await (const batch of streamUsageSource(
    bytes(records.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    "source",
    { agent: "codex" },
  ))
    events.push(...batch.events);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ input: 100, output: 10 });
  const withoutMirror = [];
  for await (const batch of streamUsageSource(
    bytes(
      records
        .slice(0, 2)
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    ),
    "source",
    { agent: "codex" },
  ))
    withoutMirror.push(...batch.events);
  expect(withoutMirror).toHaveLength(1);
});
it("uses native response IDs through cumulative counter resets, rather than discarding later requests", async () => {
  const native = (id: string, input: number, output: number) => ({
    type: "token_usage_record",
    timestamp: "2026-10-09T12:00:00Z",
    payload: {
      thread_id: "thread",
      response_id: id,
      usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: output,
      },
      thread_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: output,
      },
    },
  });
  const records = [
    { type: "session_meta", payload: { id: "thread" } },
    native("response-1", 1000, 100),
    row(1000, 100),
    native("response-2", 500, 50),
    row(500, 50),
  ];
  const events = [];
  for await (const batch of streamUsageSource(
    bytes(records.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    "source",
    { agent: "codex" },
  ))
    events.push(...batch.events);
  expect(events.map((e) => e.id)).toEqual([
    "codex-response:response-1",
    "codex-response:response-2",
  ]);
  expect(events.reduce((n, e) => n + e.input + e.output, 0)).toBe(1650);
});
