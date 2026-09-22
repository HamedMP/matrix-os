import { describe, expect, it } from "vitest";
import { codexToolOutput as protectedOutput } from "../../packages/gateway/src/coding-agents/codex-tool-output.mjs";

import { openToolOutput } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
const key = Buffer.alloc(32, 5);
function codexToolOutput(item: Record<string, unknown>) {
  const output = protectedOutput(item, false, { key, toolCallId: "test_tool" });
  if (!output?.protectedOutput) return output;
  return { text: openToolOutput(key, "test_tool", output.protectedOutput), truncated: output.truncated };
}

describe("Codex safe tool result display", () => {
  it("preserves bounded command results", () => {
    expect(codexToolOutput({ type: "commandExecution", aggregatedOutput: "12 tests passed\n" }))
      .toEqual({ text: "12 tests passed\n", truncated: false });
  });
  it("retains text blocks from connected tool results", () => {
    expect(codexToolOutput({ type: "mcpToolCall", result: { content: [{ type: "text", text: "Found 3 documents" }] } }))
      .toEqual({ text: "Found 3 documents", truncated: false });
  });
  it.each(["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c3ludGhldGlj", "API_TOKEN=private", "password: private", "Bearer private", "/Users/private/file", "postgresql://private/db", "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----", "{\"access_token\":\"private\"}"])("withholds sensitive output: %s", (aggregatedOutput) => {
    expect(codexToolOutput({ type: "commandExecution", aggregatedOutput }))
      .toEqual({ text: "Output withheld because it may contain private data.", truncated: true });
  });
  it("withholds opaque values from a secret-bearing command", () => {
    expect(codexToolOutput({ command: 'echo "$CUSTOM_TOKEN"', aggregatedOutput: "opaque-value" }))
      .toEqual({ text: "Output withheld because it may contain private data.", truncated: true });
  });
  it("bounds output and marks truncation", () => {
    const result = codexToolOutput({ aggregatedOutput: "x".repeat(5000) });
    expect(result.text).toHaveLength(4000);
    expect(result.truncated).toBe(true);
  });
  it("does not invent results for empty or unknown envelopes", () => {
    expect(codexToolOutput({})).toBeUndefined();
    expect(codexToolOutput({ result: { image: "opaque" } })).toBeUndefined();
  });
});
