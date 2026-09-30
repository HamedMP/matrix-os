import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { previewLocalChatSource } from "../../packages/contracts/src/local-chat-import/preview.js";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
function input(records: unknown[]) {
  const raw = new TextEncoder().encode(records.map(value => JSON.stringify(value)).join("\n") + "\n");
  const hash = createHash("sha256");
  async function* chunks() { for (let n = 0; n < raw.length; n += 37) { const bytes = raw.slice(n, n + 37); hash.update(bytes); yield bytes; } }
  return { chunks: chunks(), rawSize: raw.length, sourceHash: () => hash.digest("hex") };
}
describe("bounded local Chat preview", () => {
  it("counts Claude fragments as one response and keeps tools, thinking, and nested media distinct", async () => {
    const preview = await previewLocalChatSource("claude", input([
      { type: "user", sessionId: sourceId, uuid: "u", cwd: "/synthetic/repo", message: { content: "Synthetic input" } },
      { type: "assistant", sessionId: sourceId, uuid: "a1", message: { id: "response", content: [{ type: "thinking", thinking: "Synthetic private context" }, { type: "text", text: "Saved response" }] } },
      { type: "assistant", sessionId: sourceId, uuid: "a2", message: { id: "response", content: [{ type: "text", text: "Second response fragment" }, { type: "tool_use", id: "call", name: "synthetic", input: {} }] } },
      { type: "user", sessionId: sourceId, uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }] } },
    ]));
    expect(preview).toMatchObject({ harness: "claude", sourceId, counts: { humanInputs: 1, assistantResponses: 1, toolCalls: 1, toolResults: 1, attachments: 1, thinkingRecords: 1 }, firstVisibleText: "Synthetic input" });
    expect(JSON.stringify(preview)).not.toContain("Synthetic private context"); expect(preview.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview).not.toHaveProperty("messages");
  });
  it("collapses Codex mirror counts but preserves two identical legitimate human inputs", async () => {
    const preview = await previewLocalChatSource("codex", input([
      { type: "session_meta", payload: { id: sourceId } },
      { type: "event_msg", payload: { type: "turn_started", turn_id: "one" } },
      { type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "Again" }] } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "one", item: { type: "UserMessage", id: "u-mirror", content: [{ type: "text", text: "Again" }] } } },
      { type: "event_msg", payload: { type: "turn_started", turn_id: "two" } },
      { type: "response_item", payload: { type: "message", id: "u2", role: "user", content: [{ type: "input_text", text: "Again" }] } },
    ]));
    expect(preview.counts.humanInputs).toBe(2);
  });
  it("rejects mismatched sessions instead of choosing one silently", async () => {
    await expect(previewLocalChatSource("claude", input([
      { type: "user", sessionId: sourceId, uuid: "u", message: { content: "One" } },
      { type: "user", sessionId: "019eb0ae-9a30-7541-bdb8-db4d17e65147", uuid: "v", message: { content: "Two" } },
    ]))).rejects.toMatchObject({ code: "source_mismatch" });
  });
});
