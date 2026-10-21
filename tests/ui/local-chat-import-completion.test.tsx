// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatImportPanel } from "../../packages/ui/src/chat-import/ChatImportPanel";
import type { NativeChatImportAdapter } from "../../packages/ui/src/chat-import/import-state";
const sources = ["a", "b"].map(key => ({ sourceKey: key, harness: "codex" as const, title: `Conversation ${key}`, rawBytes: 1000, updatedAt: "2026-10-19T12:00:00Z" }));
const counts = { humanInputs: 1, assistantResponses: 1, agentInputs: 0, toolCalls: 0, toolResults: 0, attachments: 0, externalReferences: 0, thinkingRecords: 0, contextRecords: 0, unknownRecords: 0, sourceIssues: 0 };
type Result = { chatId: string; jobId: string; messageCount: number };
function adapter() {
    return {
        discover: vi.fn(async () => ({ sources, limited: false })),
        prepare: vi.fn(async (keys: string[]) => ({ selections: keys.map(key => ({ selectionId: key, preview: { harness: "codex" as const, sourceId: key, sourceHash: key.repeat(64), rawBytes: 1000, title: `Conversation ${key}`, firstVisibleText: `Preview ${key}`, parserVersion: 1 as const, counts } })), errors: [] })),
        apply: vi.fn<NativeChatImportAdapter["apply"]>(async id => ({ chatId: `chat_${id}`, jobId: id, messageCount: 2 })),
        release: vi.fn(async () => {}),
        pause: vi.fn(),
    };
}
async function previewFirstAndImportBoth(native: ReturnType<typeof adapter>) {
    render(<ChatImportPanel native={native}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Conversation a" }));
    await screen.findByText("Preview a");
    fireEvent.click(screen.getByRole("button", { name: "Import 2 selected chats" }));
    await waitFor(() => expect(native.apply).toHaveBeenCalledTimes(2));
    await screen.findByText("Imported 2 history entries into Matrix Chat.");
}
function expectUnfinished() {
    expect(screen.queryByRole("heading", { name: "Your chats are in Matrix" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start another batch" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Review conversations" })).toBeTruthy();
}
afterEach(cleanup);
describe("discovered import completion summary", () => {
    it("waits for the entire selected queue, then resets the completed batch", async () => {
        const native = adapter();
        let finish!: (value: Result) => void;
        native.apply.mockImplementation(async id => id === "b" ? new Promise<Result>(resolve => { finish = resolve; }) : { chatId: "chat_a", jobId: "a", messageCount: 2 });
        await previewFirstAndImportBoth(native);
        expectUnfinished();
        await act(async () => { finish({ chatId: "chat_b", jobId: "b", messageCount: 2 }); });
        await screen.findByRole("heading", { name: "Your chats are in Matrix" });
        fireEvent.click(screen.getByRole("button", { name: "Start another batch" }));
        await waitFor(() => expect(native.discover).toHaveBeenCalledTimes(2));
        expect(native.pause).toHaveBeenCalledWith(true);
        fireEvent.click(await screen.findByRole("button", { name: "Preview Conversation a" }));
        await screen.findByText("Preview a");
        expectUnfinished();
    });
    it("keeps the batch unfinished when a non-previewed selection fails, then permits retry", async () => {
        const native = adapter();
        native.apply.mockImplementationOnce(async () => ({ chatId: "chat_a", jobId: "a", messageCount: 2 }));
        native.apply.mockRejectedValueOnce(new Error("Synthetic unavailable transcript"));
        await previewFirstAndImportBoth(native);
        await screen.findByRole("button", { name: "Import 1 selected chat" });
        expectUnfinished();
        fireEvent.click(screen.getByRole("button", { name: "Import 1 selected chat" }));
        await screen.findByRole("heading", { name: "Your chats are in Matrix" });
        expect(native.apply.mock.calls.map(call => call[0])).toEqual(["a", "b", "b"]);
        expect(screen.getByRole("button", { name: "Start another batch" })).toBeTruthy();
    });
    it("keeps a stopped queue unfinished and ignores its late completion", async () => {
        const native = adapter();
        let finish!: (value: Result) => void;
        native.apply.mockImplementation(async id => id === "b" ? new Promise<Result>(resolve => { finish = resolve; }) : { chatId: "chat_a", jobId: "a", messageCount: 2 });
        await previewFirstAndImportBoth(native);
        fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
        await screen.findByRole("button", { name: "Import 1 selected chat" });
        expectUnfinished();
        await act(async () => { finish({ chatId: "chat_late", jobId: "b", messageCount: 2 }); });
        expectUnfinished();
        expect(screen.queryByText("2 chats ready in Matrix.")).toBeNull();
    });
});
