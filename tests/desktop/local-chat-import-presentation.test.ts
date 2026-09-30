import { describe, expect, it } from "vitest";
import { CanonicalChatMessageSchema } from "@matrix-os/contracts";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
const createdAt = "2026-09-30T00:00:00Z";
const provenance = { type: "import_provenance", harness: "codex", sourceId: "019eb0ae-9a30-7541-bdb8-db4d17e65146", sourceKey: "a".repeat(64), phase: "final", origin: "assistant", offset: 100, end: 200 };
describe("historical Chat presentation", () => {
  it("shows imported assistant-only history without inventing a user message or live run", () => {
    const message = CanonicalChatMessageSchema.parse({ id: "msg_imported_assistant", chatId: "chat_imported_test", seq: 1,
      role: "assistant", state: "committed", createdAt, parts: [{ type: "text", text: "An imported answer" }, provenance] });
    const view = canonicalChatPresentation({ messages: [message], turns: [], runs: [], activities: [] });
    expect(view).toHaveLength(1); expect(view[0]?.user).toBeUndefined(); expect(view[0]?.active).toBe(false);
    expect(view[0]?.final).toMatchObject({ markdown: "An imported answer" });
    expect(JSON.stringify(view)).not.toContain("Retry");
  });
  it("shows media-only imported messages and links full content to exact Chat assets", () => {
    const assetId = "019eb0ae-9a30-7541-bdb8-db4d17e65147";
    const message = CanonicalChatMessageSchema.parse({ id: "msg_imported_media", chatId: "chat_imported_test", seq: 1,
      role: "assistant", state: "committed", createdAt, parts: [provenance,
        { type: "import_reference", assetId, kind: "image", label: "Imported image", mimeType: "image/png", sizeBytes: 70 },
        { type: "import_reference", assetId: "019eb0ae-9a30-7541-bdb8-db4d17e65148", kind: "text", label: "Full message", mimeType: "text/plain", sizeBytes: 90_000 },
      ] });
    const view = canonicalChatPresentation({ messages: [message], turns: [], runs: [], activities: [] });
    expect(view[0]?.final).toMatchObject({ content: expect.arrayContaining([
      expect.objectContaining({ kind: "image", src: `/api/chats/chat_imported_test/imports/assets/${assetId}/content` }),
      expect.objectContaining({ kind: "reference", referenceKind: "file", importAsset: { chatId: "chat_imported_test", assetId: "019eb0ae-9a30-7541-bdb8-db4d17e65148", label: "Full message" } }),
    ]) });
  });
  it("keeps every distinct result and marks unmatched historical calls incomplete", () => {
    const message = CanonicalChatMessageSchema.parse({ id: "msg_imported_tools", chatId: "chat_imported_test", seq: 1,
      role: "tool", state: "committed", createdAt, parts: [
        { ...provenance, phase: "tool", origin: "tool" },
        { type: "tool_request", toolCallId: "call_missing", name: "synthetic", label: "Synthetic call" },
        ...Array.from({ length: 37 }, (_, n) => ({ type: "tool_result", toolCallId: "call_many", outcome: "success", truncated: false, text: `Result ${n}` })),
      ] });
    const view = canonicalChatPresentation({ messages: [message], turns: [], runs: [], activities: [] });
    const text = JSON.stringify(view); for (let n = 0; n < 37; n++) expect(text).toContain(`Result ${n}`);
    expect(text).not.toContain('"state":"running"'); expect(text).toContain("incomplete");
  });
  it("links calls and later result messages without moving activity out of source order", () => {
    const saved = (id: string, seq: number, parts: unknown[]) => CanonicalChatMessageSchema.parse({ id, chatId: "chat_imported_test", seq,
      role: "tool", state: "committed", createdAt, parts: [{ ...provenance, phase: "tool", origin: "tool" }, ...parts] });
    const messages = [saved("msg_call", 1, [{ type: "tool_request", toolCallId: "call_linked", name: "synthetic", label: "Synthetic command", inputPreview: "Synthetic input" }]),
      ...Array.from({ length: 37 }, (_, n) => saved(`msg_result_${n}`, n + 2, [{ type: "tool_result", toolCallId: "call_linked", outcome: "success", truncated: false, text: `Result ${n}` }]))];
    const view = canonicalChatPresentation({ messages, turns: [], runs: [], activities: [] });
    const activities = view[0]!.work.flatMap(item => item.kind === "activity-group" ? item.activities : []);
    expect(activities).toHaveLength(38); expect(activities.every(item => item.state === "completed")).toBe(true);
    expect(activities.every(item => item.label === "Synthetic command")).toBe(true);
    expect(activities.slice(1).map(item => item.detail)).toEqual(Array.from({ length: 37 }, (_, n) => `Synthetic input\n\nResult ${n}`));
  });
  it("merges contiguous response fragments and retains text on either side of tool activity", () => {
    const saved = (id: string, seq: number, parts: unknown[]) => CanonicalChatMessageSchema.parse({ id, chatId: "chat_imported_test", seq,
      role: "assistant", state: "committed", createdAt, parts: [provenance, ...parts] });
    const view = canonicalChatPresentation({ messages: [saved("msg_first", 1, [{ type: "text", text: "First fragment" }]),
      saved("msg_second", 2, [{ type: "text", text: "Second fragment" }]),
      saved("msg_tool", 3, [{ type: "tool_request", toolCallId: "call_fragment", name: "synthetic", label: "Synthetic tool" }]),
      saved("msg_third", 4, [{ type: "text", text: "After the tool" }])], turns: [], runs: [], activities: [] });
    const before = view[0]!.work.filter(item => item.kind === "message");
    expect(before).toHaveLength(1); expect(before[0]).toMatchObject({ markdown: "First fragment\n\nSecond fragment" });
    expect(view[0]!.final).toMatchObject({ markdown: "After the tool" });
    expect(view[0]!.work[1]).toMatchObject({ kind: "activity-group" });
  });

  it("keeps distinct media occurrences when content-addressed assets share one ID", () => {
    const assetId = "019eb0ae-9a30-7541-bdb8-db4d17e65147";
    const message = CanonicalChatMessageSchema.parse({ id: "msg_occurrences", chatId: "chat_imported_test", seq: 1,
      role: "assistant", state: "committed", createdAt, parts: [provenance,
        ...Array.from({ length: 2 }, () => ({ type: "import_reference", assetId, kind: "image", label: "Imported image", mimeType: "image/png", sizeBytes: 70 }))] });
    const view = canonicalChatPresentation({ messages: [message], turns: [], runs: [], activities: [] });
    const images = view[0]!.final!.content!.filter(item => item.kind === "image");
    expect(images).toHaveLength(2); expect(new Set(images.map(item => item.id)).size).toBe(2);
  });

});
