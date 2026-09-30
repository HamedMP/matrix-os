// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatImportPanel } from "../../packages/ui/src/chat-import/ChatImportPanel";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const preview = { harness: "claude" as const, sourceId, sourceHash: "a".repeat(64), rawBytes: 800, title: "Synthetic conversation", firstVisibleText: "Synthetic prompt", parserVersion: 1 as const, counts: { humanInputs: 1, assistantResponses: 1, agentInputs: 0, toolCalls: 1, toolResults: 2, attachments: 1, externalReferences: 1, thinkingRecords: 1, contextRecords: 2, unknownRecords: 0, sourceIssues: 1 } };
afterEach(cleanup);
describe("full Chat import Settings", () => {
    it("lets the owner preview Claude before explicitly uploading originals and readable history", async () => {
        const select = vi.fn(async () => ({ selectionId: sourceId, preview }));
        const apply = vi.fn(async () => ({ chatId: "chat_synthetic", jobId: sourceId, messageCount: 2 }));
        const open = vi.fn();
        render(<ChatImportPanel native={{ select, apply, pause: vi.fn() }} onOpenChat={open}/>);
        fireEvent.change(screen.getByLabelText("Chat tool"), { target: { value: "claude" } });
        fireEvent.click(screen.getByRole("button", { name: "Choose transcript" }));
        expect(await screen.findByText("Synthetic prompt")).toBeTruthy();
        expect(select).toHaveBeenCalledWith("claude", expect.any(AbortSignal));
        expect(apply).not.toHaveBeenCalled();
        expect(screen.getByText(/1 tool call/)).toBeTruthy();
        expect(screen.getByText(/1 external reference/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Import private Chat" }));
        expect(await screen.findByText("Imported 2 history entries into Matrix Chat.")).toBeTruthy();
        expect(apply).toHaveBeenCalledWith(sourceId, "Synthetic conversation", expect.any(AbortSignal), expect.any(Function));
        fireEvent.click(screen.getByRole("button", { name: "Open Chat" }));
        expect(open).toHaveBeenCalledWith("chat_synthetic", "Synthetic conversation");
    });
    it("hides internal errors and stops native work when the panel closes", async () => {
        const pause = vi.fn();
        const select = vi.fn(async () => { throw new Error("postgres://private-server/credential"); });
        const { unmount } = render(<ChatImportPanel native={{ select, apply: vi.fn(), pause }}/>);
        fireEvent.click(screen.getByRole("button", { name: "Choose transcript" }));
        expect((await screen.findByRole("alert")).textContent).not.toContain("private-server");
        unmount();
        expect(pause).toHaveBeenCalled();
    });
});
