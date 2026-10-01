import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { previewCodexBrowserFile } from "../../packages/ui/src/chat-import/preview.js";

describe("browser Codex Chat import preview", () => {
  it("hashes a selected file incrementally and projects only visible messages", async () => {
    const raw = [
      JSON.stringify({ type: "session_meta", payload: { id: "019eb0ae-9a30-7541-bdb8-db4d17e65146", cwd: "/work/example" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-03T16:01:00Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }],
      } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "private" } }),
    ].join("\n") + "\n";
    const blob = new Blob([raw], { type: "application/jsonl" });
    const preview = await previewCodexBrowserFile(blob);
    expect(preview.sourceHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(preview.messages).toMatchObject([{ role: "user", text: "Hello" }]);
    expect(preview.title).toBe("Hello");
  });
  it("preserves the transcript digest across byte-sized UTF-8 stream chunks", async () => {
    const raw = [
      JSON.stringify({ type: "session_meta", payload: { id: "019eb0ae-9a30-7541-bdb8-db4d17e65146", cwd: "/work/example" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-03T16:01:00Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Hello 🌍" }],
      } }),
    ].join("\n") + "\n";
    const bytes = new TextEncoder().encode(raw);
    const file = { size: bytes.length, stream: () => new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }) } as Blob;
    const preview = await previewCodexBrowserFile(file);
    expect(preview.sourceHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(preview.messages).toMatchObject([{ role: "user", text: "Hello 🌍" }]);
  });

});
