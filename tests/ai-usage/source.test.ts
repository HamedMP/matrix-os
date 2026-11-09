import { describe, it, expect } from "vitest";
import {
  readUsageSource,
  readUsageExport,
} from "../../packages/contracts/src/ai-usage/source";
async function* bytes(text: string) {
  yield new TextEncoder().encode(text);
}
describe("usage import boundary", () => {
  it("reuses the import JSONL reader and returns counters without conversation text", async () => {
    const text =
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-09T12:00:00Z",
        sessionId: "s",
        message: {
          id: "m",
          model: "future",
          content: [{ type: "text", text: "PRIVATE PROMPT" }],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      }) + "\n{bad}\n";
    const result = await readUsageSource(bytes(text), "source");
    expect(result.events).toHaveLength(1);
    expect(result.issues).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("validates exported metrics and strips extra fields rather than displaying arbitrary payloads", () => {
    expect(() =>
      readUsageExport({ version: 1, events: [{ id: "bad", input: -1 }] }),
    ).toThrow();
    expect(() => readUsageExport({ version: 2, events: [] })).toThrow();
    expect(
      readUsageExport({ version: 1, events: [], issues: 3, private: "secret" }),
    ).toEqual({ version: 1, events: [], issues: 3 });
  });
});
it("marks partial JSONL tails rather than completing a live response", async () => {
  const r = await readUsageSource(bytes('{"type":"assistant"}'), "tail");
  expect(r.events).toEqual([]);
  expect(r.issues).toBeGreaterThan(0);
});
