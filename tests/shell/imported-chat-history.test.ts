import { describe, expect, it } from "vitest";
import type { CanonicalChatMessage } from "@matrix-os/contracts";
import { projectCanonicalMessages } from "../../shell/src/lib/canonical-chat-client";

const provenance = { type: "import_provenance" as const, harness: "codex" as const, sourceId: "source", sourceKey: "key", phase: "tool" as const, origin: "tool" as const, offset: 0, end: 1 };
function message(seq: number, role: CanonicalChatMessage["role"], parts: CanonicalChatMessage["parts"]): CanonicalChatMessage {
  return { id: `msg_${seq}`, chatId: "chat_history", seq, role, state: "committed", createdAt: "2026-10-18T00:00:00Z", parts: [...parts, provenance] };
}
describe("imported Web Chat history", () => {
  it("pairs saved results with calls, keeps output collapsed, and never shows historical work as running", () => {
    const projected = projectCanonicalMessages([
      message(1, "user", [{ type: "text", text: "My request" }]),
      message(2, "tool", [{ type: "tool_request", toolCallId: "call_one", name: "Read", label: "Read file" }]),
      message(3, "assistant", [{ type: "text", text: "Checking the file." }]),
      message(4, "tool", [{ type: "tool_result", toolCallId: "call_one", outcome: "success", text: "Saved output" }]),
      message(5, "tool", [{ type: "tool_request", toolCallId: "call_missing", name: "Search", label: "Search" }]),
      message(6, "tool", [{ type: "tool_result", toolCallId: "call_orphan", outcome: "failed", text: "Failed output" }]),
      message(7, "assistant", [{ type: "text", text: "The answer." }]),
    ]);
    expect(projected.filter(m => !m.tool).map(m => m.content)).toEqual(["My request", "Checking the file.", "The answer."]);
    expect(projected.filter(m => m.tool).map(m => m.toolDisplay)).toEqual([
      expect.objectContaining({ label: "Read file", state: "completed", detail: "Saved output" }),
      expect.objectContaining({ label: "Search", state: "partial" }),
      expect.objectContaining({ state: "failed", detail: "Failed output" }),
    ]);
  });
  it("keeps owner-only full-content references reachable", () => {
    expect(projectCanonicalMessages([message(1, "assistant", [
      { type: "import_reference", assetId: "asset_history", kind: "text", label: "Full message", mimeType: "text/plain", sizeBytes: 9000 },
    ])])[0]?.attachments).toEqual([expect.objectContaining({ importAsset: { chatId: "chat_history", assetId: "asset_history", label: "Full message" } })]);
  });
  it("shows saved instruction envelopes as collapsed context, preserving actual human prose", () => {
    const envelope = "<skill>\n<name>example</name>\n<path>/skills/example/SKILL.md</path>\nInstructions\n</skill>";
    const projected = projectCanonicalMessages([message(1, "user", [{ type: "text", text: envelope }]), message(2, "user", [{ type: "text", text: `Please inspect this: ${envelope}` }])]);
    expect(projected[0]?.toolDisplay).toMatchObject({ label: "Imported instructions", state: "completed", detail: envelope });
    expect(projected[1]?.role).toBe("user");
  });
});
