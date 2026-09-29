// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatImportPanel } from "../../packages/ui/src/chat-import/ChatImportPanel.js";

describe("Chat import Settings panel", () => {
  it("shows a safe line number for a malformed selected transcript", async () => {
    const raw = '{"type":"session_meta","payload":{"id":"019eb0ae-9a30-7541-bdb8-db4d17e65146","cwd":"/work"}}\n{"type":"response_item","payload":{"type":"message"}\n';
    const file = new File([raw], "broken.jsonl");
    Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(raw)); controller.close(); },
    }) });
    render(<ChatImportPanel request={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Choose a Codex transcript"), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Invalid Codex JSONL at line 2");
  });
  it("previews a chosen file and imports only after its explicit button is pressed", async () => {
    const raw = [
      JSON.stringify({ type: "session_meta", payload: { id: "019eb0ae-9a30-7541-bdb8-db4d17e65146", cwd: "/work/example" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-03T16:01:00Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }],
      } }),
    ].join("\n") + "\n";
    const file = new File([raw], "rollout-example.jsonl", { type: "application/jsonl" });
    Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(raw)); controller.close(); },
    }) });
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/complete")) return { chatId: "chat_imported", messageCount: 1 };
      if (path.endsWith("/messages")) return { nextSeq: 2 };
      if (path.endsWith("/chat_imported?limit=1")) return { record: { chat: { messageCount: 1 } } };
      return { status: "uploading", nextSeq: 1 };
    });
    const onOpenChat = vi.fn();
    render(<ChatImportPanel request={request} onOpenChat={onOpenChat} />);
    fireEvent.change(screen.getByLabelText("Choose a Codex transcript"), { target: { files: [file] } });
    expect(await screen.findByText("1 message ready to import")).toBeTruthy();
    expect(screen.getByText("Session: 019eb0ae-9a30-7541-bdb8-db4d17e65146")).toBeTruthy();
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import private Chat" }));
    expect(await screen.findByText("Imported 1 message into Matrix Chat.")).toBeTruthy();
    expect(request).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Chat" }));
    expect(onOpenChat).toHaveBeenCalledWith("chat_imported", "Hello");
  });
});
