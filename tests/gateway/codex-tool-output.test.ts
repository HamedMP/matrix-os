import { describe, expect, it } from "vitest";
import { codexToolOutput } from "../../packages/gateway/src/coding-agents/codex-tool-output.mjs";

describe("Codex safe tool result display", () => {
  it("preserves bounded command results", () => {
    expect(codexToolOutput({ type: "commandExecution", aggregatedOutput: "12 tests passed\n" }))
      .toEqual({ text: "12 tests passed\n", truncated: false });
  });
  it("retains text blocks from connected tool results", () => {
    expect(codexToolOutput({ type: "mcpToolCall", result: { content: [{ type: "text", text: "Found 3 documents" }] } }))
      .toEqual({ text: "Found 3 documents", truncated: false });
  });
  it.each(["API_TOKEN=private", "password: private", "Bearer private", "/Users/private/file", "postgresql://private/db", "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----", "{\"access_token\":\"private\"}"])("withholds sensitive output: %s", (aggregatedOutput) => {
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
