// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatImportPanel } from "../../packages/ui/src/chat-import/ChatImportPanel.js";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const jobId = "019eb0ae-9a30-7541-bdb8-db4d17e65147";
function file(raw: string) { const value = new File([raw], "selected.jsonl"); Object.defineProperty(value, "slice", { value: (offset: number, end: number) => ({ arrayBuffer: async () => new TextEncoder().encode(raw).slice(offset, end).buffer }) }); return value; }
const meta = JSON.stringify({ type: "session_meta", payload: { id: sourceId, cwd: "/work" } });
const prompt = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } });
afterEach(cleanup);
describe("browser original-archive import", () => {
    it("preserves damaged lines in the archive and reports a source issue alongside readable content", async () => {
        const request = vi.fn();
        render(<ChatImportPanel transport={{ request, put: vi.fn() }}/>);
        fireEvent.change(screen.getByLabelText("Choose a Codex transcript"), { target: { files: [file([meta, "{broken", prompt].join("\n") + "\n")] } });
        expect(await screen.findByText(/1 source issue recorded/)).toBeTruthy();
        expect(screen.getByText("Hello")).toBeTruthy();
        expect(request).not.toHaveBeenCalled();
    });
    it("previews locally, uploads exact original bytes only on explicit action, then opens the verified private Chat", async () => {
        const raw = [meta, prompt].join("\n") + "\n";
        const bytes = new TextEncoder().encode(raw);
        let published = false;
        const state = () => ({ jobId, status: published ? "published" : "uploading", partSize: 64 * 1024 ** 2, totalParts: 1, expiresAt: "2026-10-01T00:00:00Z", cleanupPending: false, parts: [], ...(published ? { chatId: "chat_imported" } : {}) });
        const request = vi.fn(async (path: string) => { if (path.endsWith("/parts"))
            return { parts: [{ partNumber: 1, size: bytes.length, url: "https://storage.example.test/part", expiresAt: "2026-10-01T00:00:00Z" }] }; if (path.endsWith("/complete")) {
            published = true;
            return state();
        } if (path.endsWith("chat_imported?limit=1"))
            return { record: { chat: { id: "chat_imported", messageCount: 1 } } }; return state(); });
        const put = vi.fn(async () => "synthetic-etag");
        const open = vi.fn();
        render(<ChatImportPanel transport={{ request, put }} onOpenChat={open}/>);
        fireEvent.change(screen.getByLabelText("Choose a Codex transcript"), { target: { files: [file(raw)] } });
        expect(await screen.findByText("Hello")).toBeTruthy();
        expect(request).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Import private Chat" }));
        expect(await screen.findByText("Imported 1 history entry into Matrix Chat.")).toBeTruthy();
        expect(Array.from(put.mock.calls[0]?.[1] as Uint8Array)).toEqual(Array.from(bytes));
        fireEvent.click(screen.getByRole("button", { name: "Open Chat" }));
        expect(open).toHaveBeenCalledWith("chat_imported", "Hello");
    });
});
