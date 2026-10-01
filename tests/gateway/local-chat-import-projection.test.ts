import { describe, expect, it, vi } from "vitest";
import { CanonicalChatMessageSchema } from "@matrix-os/contracts";
import type { ImportProjection } from "@matrix-os/contracts/local-chat-import";
import { projectImportedChatRecord } from "../../packages/gateway/src/chat/local-import/canonical-projection.js";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const assetId = "019eb0ae-9a30-7541-bdb8-db4d17e65147";
const base = { conversation: { harness: "codex" as const, sessionId: sourceId }, source: { line: 1, offset: 0, end: 500 } };
function sink() { return vi.fn(async (_input: { bytes: Uint8Array; sha256: string; mimeType: string }) => ({ assetId })); }
function validate(parts: unknown[], role = "assistant") { return CanonicalChatMessageSchema.parse({ id: "msg_synthetic_projection", chatId: "chat_synthetic_projection", seq: 1, role, state: "committed", parts, createdAt: "2026-09-30T00:00:00Z" }); }
describe("private archive to canonical readable projection", () => {
  it("preserves full large UTF-8 content privately with a bounded readable preview", async () => {
    const text = "🧠".repeat(20_000); const storeAsset = sink();
    const rows = await projectImportedChatRecord({ ...base, kind: "message", role: "assistant", origin: "assistant", phase: "final", messageKey: "answer", blocks: [{ kind: "text", text }] }, { storeAsset });
    expect(storeAsset).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(storeAsset.mock.calls[0]![0].bytes)).toBe(text);
    expect(rows).toHaveLength(1); validate(rows[0]!.parts);
    expect(rows[0]!.parts).toContainEqual(expect.objectContaining({ type: "import_reference", kind: "text", sizeBytes: 80_000 }));
    expect(rows[0]!.parts.some(part => part.type === "text" && part.text.endsWith("\ud83e"))).toBe(false);
  });
  it("keeps injected context and thinking out of shared readable Chat parts", async () => {
    const storeAsset = sink();
    for (const event of [{ ...base, kind: "context", blocks: [{ kind: "text", text: "Private instructions" }] }, { ...base, kind: "thinking", text: "Private thought" }, { ...base, kind: "unknown", recordType: "future" }] as ImportProjection[]) {
      expect(await projectImportedChatRecord(event, { storeAsset })).toEqual([]);
    }
    expect(storeAsset).not.toHaveBeenCalled();
  });
  it("projects child agent input without labeling it as human input", async () => {
    const rows = await projectImportedChatRecord({ ...base, kind: "message", role: "user", origin: "agent_task", phase: "unknown", messageKey: "task", blocks: [{ kind: "text", text: "Agent task" }] }, { storeAsset: sink() });
    expect(rows[0]?.role).toBe("assistant");
    expect(rows[0]?.parts).toContainEqual(expect.objectContaining({ type: "import_provenance", phase: "agent_task", origin: "agent_task" }));
    validate(rows[0]!.parts);
  });
  it("externalizes tool input and preserves every separate result with safe call IDs", async () => {
    const storeAsset = sink(); const callId = "unsafe / call";
    const call = await projectImportedChatRecord({ ...base, kind: "tool_call", callId, name: "/home/private/tool", input: { command: "full input" } }, { storeAsset });
    expect(call[0]?.parts).toContainEqual(expect.objectContaining({ type: "tool_request", name: "Imported tool" }));
    expect(new TextDecoder().decode(storeAsset.mock.calls[0]![0].bytes)).toContain("full input");
    const callPart = call[0]!.parts.find(part => part.type === "tool_request");
    for (let index = 0; index < 37; index++) {
      const rows = await projectImportedChatRecord({ ...base, source: { ...base.source, offset: 500 + index, end: 600 + index }, kind: "tool_result", callId, outcome: "success", blocks: [{ kind: "text", text: `Result ${index}` }] }, { storeAsset });
      validate(rows[0]!.parts, "tool");
      expect(rows[0]!.parts).toContainEqual(expect.objectContaining({ type: "tool_result", toolCallId: callPart?.type === "tool_request" ? callPart.toolCallId : undefined, text: `Result ${index}` }));
    }
  });
  it("extracts embedded media bytes but never follows local or remote references", async () => {
    const storeAsset = sink();
    const pdf = "%PDF-1.7\nsynthetic PDF\n%%EOF\n";
    const rows = await projectImportedChatRecord({ ...base, kind: "tool_result", callId: "media", outcome: "success", blocks: [
      { kind: "media", encoding: "base64", mediaType: "application/pdf", data: Buffer.from(pdf).toString("base64") },
      { kind: "media", encoding: "local", data: "/private/missing.png" },
      { kind: "media", encoding: "url", data: "https://private.invalid/file" },
    ] }, { storeAsset });
    expect(storeAsset).toHaveBeenCalledTimes(1); expect(new TextDecoder().decode(storeAsset.mock.calls[0]![0].bytes)).toBe(pdf);
    expect(JSON.stringify(rows)).not.toContain("/private/"); expect(JSON.stringify(rows)).not.toContain("private.invalid");
    expect(rows[0]?.parts.filter(part => part.type === "status")).toHaveLength(2); validate(rows[0]!.parts, "tool");
  });
  it("splits human previews at the aggregate input bound while preserving full source bytes", async () => {
    const blocks = Array.from({ length: 5 }, () => ({ kind: "text" as const, text: "x".repeat(9000) }));
    const rows = await projectImportedChatRecord({ ...base, kind: "message", role: "user", origin: "human", phase: "unknown", messageKey: "large_user", blocks }, { storeAsset: sink() });
    for (const row of rows) validate(row.parts, "user");
    expect(rows.length).toBeGreaterThan(1);
  });
  it("splits many content blocks into valid bounded messages without losing occurrences", async () => {
    const blocks = Array.from({ length: 150 }, (_, n) => ({ kind: "text" as const, text: `Block ${n}\n` }));
    const rows = await projectImportedChatRecord({ ...base, kind: "message", role: "user", origin: "human", phase: "unknown", messageKey: "user", blocks }, { storeAsset: sink() });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) validate(row.parts, "user");
    const text = rows.flatMap(row => row.parts).filter(part => part.type === "text").map(part => part.text).join("");
    expect(text).toBe(blocks.map(block => block.text).join(""));
    expect(new Set(rows.map(row => row.recordKey)).size).toBe(rows.length);
  });
});
