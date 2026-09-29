import { describe, expect, it } from "vitest";
import { decodeCodexJsonl, parseCodexTranscript } from "../../packages/contracts/src/codex-chat-import.js";

const line = (value: unknown) => JSON.stringify(value);

describe("Codex transcript import projection", () => {
  it("accepts JSONL with whitespace around keys", async () => {
    const result = await parseCodexTranscript([
      '{ "type" : "session_meta", "payload" : { "id" : "019eb0ae-9a30-7541-bdb8-db4d17e65146", "cwd" : "/work/repo" } }',
      '{ "type" : "response_item", "timestamp" : "2026-09-03T16:01:00Z", "payload" : { "type" : "message", "role" : "user", "content" : [{ "type" : "input_text", "text" : "Hello" }] } }',
    ]);
    expect(result.messages.map((message) => message.text)).toEqual(["Hello"]);
  });
  it("keeps the human conversation in order without internal instructions, tool output, or duplicate events", async () => {
    const result = await parseCodexTranscript([
      line({ type: "session_meta", payload: { id: "019eb0ae-9a30-7541-bdb8-db4d17e65146",
        cwd: "/Users/ash/projects/example", git: { repository_url: "https://example.com/team/example.git" } } }),
      line({ type: "response_item", timestamp: "2026-09-03T16:00:00Z", payload: { type: "message", role: "developer",
        content: [{ type: "input_text", text: "hidden setup" }] } }),
      line({ type: "response_item", timestamp: "2026-09-03T16:01:00Z", payload: { type: "message", role: "user",
        content: [{ type: "input_text", text: "Fix the login bug" }] } }),
      line({ type: "event_msg", payload: { type: "user_message", message: "Fix the login bug" } }),
      line({ type: "response_item", timestamp: "2026-09-03T16:01:30Z", payload: { type: "function_call_output", output: "secret" } }),
      line({ type: "response_item", timestamp: "2026-09-03T16:02:00Z", payload: { type: "message", role: "assistant",
        phase: "commentary", content: [{ type: "output_text", text: "Running checks" }] } }),
      line({ type: "response_item", timestamp: "2026-09-03T16:03:00Z", payload: { type: "message", role: "assistant",
        phase: "final_answer", content: [{ type: "output_text", text: "Fixed the login bug." }] } }),
    ]);
    expect(result).toMatchObject({
      sourceId: "019eb0ae-9a30-7541-bdb8-db4d17e65146",
      cwd: "/Users/ash/projects/example",
      repositoryUrl: "https://example.com/team/example.git",
      messages: [
        { role: "user", text: "Fix the login bug", createdAt: "2026-09-03T16:01:00.000Z" },
        { role: "assistant", text: "Fixed the login bug.", createdAt: "2026-09-03T16:03:00.000Z" },
      ],
    });
  });

  it("preserves every character of a long visible message across canonical Chat sized chunks", async () => {
    const content = "a".repeat(19_999) + "🎯" + "b".repeat(19_999);
    const result = await parseCodexTranscript([
      line({ type: "session_meta", payload: { id: "019eb0ae-9a30-7541-bdb8-db4d17e65146", cwd: "/tmp/example" } }),
      line({ type: "response_item", timestamp: "2026-09-03T16:01:00Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: content }],
      } }),
    ]);
    expect(result.messages.length).toBeGreaterThan(1);
    expect(result.messages.every((message) => message.text.length <= 20_000)).toBe(true);
    expect(result.messages.map((message) => message.text).join("")).toBe(content);
  });

  it("streams a large tool-output line without retaining it as a visible record", async () => {
    const raw = [
      line({ type: "session_meta", payload: { id: "019eb0ae-9a30-7541-bdb8-db4d17e65146", cwd: "/tmp/example" } }),
      line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(3 * 1024 * 1024) } }),
      line({ type: "response_item", timestamp: "2026-09-03T16:01:00Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Keep this" }],
      } }),
    ].join("\n") + "\n";
    const bytes = new TextEncoder().encode(raw);
    async function* chunks() {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        yield bytes.subarray(offset, offset + 64 * 1024);
      }
    }
    const result = await parseCodexTranscript(decodeCodexJsonl(chunks()));
    expect(result.messages).toMatchObject([{ role: "user", text: "Keep this" }]);
  });

  it("reports physical line numbers after skipped internal records", async () => {
    const raw = [
      line({ type: "session_meta", payload: { id: "019eb0ae-9a30-7541-bdb8-db4d17e65146", cwd: "/tmp/example" } }),
      line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(10_000) } }),
      '{"type":"response_item","payload":',
    ].join("\n") + "\n";
    async function* chunks() { yield new TextEncoder().encode(raw); }
    await expect(parseCodexTranscript(decodeCodexJsonl(chunks())))
      .rejects.toThrow("Invalid Codex JSONL at line 3");
  });
});
