// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatImportPanel } from "../../packages/ui/src/chat-import/ChatImportPanel";
import { LocalChatImportDisplayError } from "@matrix-os/contracts/local-chat-import";
const counts = { humanInputs: 1, assistantResponses: 2, agentInputs: 0, toolCalls: 1, toolResults: 1, attachments: 0, externalReferences: 0, thinkingRecords: 0, contextRecords: 0, unknownRecords: 0, sourceIssues: 0 };
function selected(id: string, title: string, harness: "claude" | "codex" = "codex") {
    return { selectionId: id, preview: { harness, sourceId: id, sourceHash: id.repeat(64).slice(0, 64), rawBytes: 1024, title, firstVisibleText: `${title} prompt`, parserVersion: 1 as const, counts } };
}
function adapter(selections = [selected("a", "First chat"), selected("b", "Second chat")]) {
    return { select: vi.fn(), selectMany: vi.fn(async () => ({ selections, errors: [] as string[] })), apply: vi.fn(async (id: string) => ({ chatId: `chat_${id}`, jobId: id, messageCount: 3 })), release:vi.fn(async()=>{}), pause: vi.fn() };
}
afterEach(cleanup);
describe("bulk local chat import", () => {
    it("previews and renames selected chats, imports sequentially, and opens each canonical result", async () => {
        const native = adapter(); const open = vi.fn();
        render(<ChatImportPanel native={native} onOpenChat={open}/>);
        fireEvent.click(screen.getByRole("button", { name: "Choose transcripts" }));
        await screen.findByText("First chat prompt");
        expect(native.apply).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText("Chat title for First chat"), { target: { value: "Renamed first" } });
        fireEvent.click(screen.getByRole("button", { name: "Import 2 private chats" }));
        await screen.findByText("2 chats are ready in Matrix.");
        expect(native.apply.mock.calls.map(call => call.slice(0, 2))).toEqual([["a", "Renamed first"], ["b", "Second chat"]]);
        fireEvent.click(screen.getByRole("button", { name: "Open Renamed first" }));
        expect(open).toHaveBeenCalledWith("chat_a", "Renamed first");
    });
    it("releases removed native previews and duplicate additions",async()=>{
        const native=adapter([selected("a","First chat")]);render(<ChatImportPanel native={native}/>);
        fireEvent.click(screen.getByRole("button",{name:"Choose transcripts"}));await screen.findByText("First chat prompt");
        native.selectMany.mockResolvedValueOnce({selections:[{...selected("a","First chat"),selectionId:"duplicate"}],errors:[]});
        fireEvent.click(screen.getByRole("button",{name:"Choose transcripts"}));
        await waitFor(()=>expect(native.release).toHaveBeenCalledWith(["duplicate"]));
        fireEvent.click(screen.getByRole("button",{name:"Remove First chat"}));
        await waitFor(()=>expect(native.release).toHaveBeenCalledWith(["a"]));
    });
    it("keeps a failed chat retryable while preserving successful results", async () => {
        const native = adapter();
        native.apply.mockImplementationOnce(async () => { throw new LocalChatImportDisplayError("Chat import is unavailable. Try again."); });
        render(<ChatImportPanel native={native}/>);
        fireEvent.click(screen.getByRole("button", { name: "Choose transcripts" }));
        await screen.findByText("First chat prompt");
        fireEvent.click(screen.getByRole("button", { name: "Import 2 private chats" }));
        await screen.findByRole("button", { name: "Retry 1 chat" });
        expect(native.apply).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByRole("button", { name: "Retry 1 chat" }));
        await screen.findByText("2 chats are ready in Matrix.");
        expect(native.apply.mock.calls.map(call => call[0])).toEqual(["a", "b", "a"]);
    });
    it("stops a hung upload immediately, skips later files, and ignores its late completion", async () => {
        const native = adapter(); let finish!: (value: {chatId: string; jobId: string; messageCount: number}) => void;
        native.apply.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        render(<ChatImportPanel native={native}/>);
        fireEvent.click(screen.getByRole("button", { name: "Choose transcripts" }));
        await screen.findByText("First chat prompt");
        fireEvent.click(screen.getByRole("button", { name: "Import 2 private chats" }));
        await screen.findByRole("button", { name: "Stop waiting" });
        fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
        expect((screen.getByRole("button", { name: "Retry 1 chat" }) as HTMLButtonElement).disabled).toBe(false);
        await act(async () => finish({ chatId: "chat_late", jobId: "a", messageCount: 3 }));
        expect(native.apply).toHaveBeenCalledTimes(1);
        expect(screen.queryByText("2 chats are ready in Matrix.")).toBeNull();
    });
    it("adds both harnesses, skips identical previews, and allows removing a queued chat", async () => {
        const native = adapter([selected("a", "First chat")]);
        native.selectMany.mockResolvedValueOnce({selections: [selected("a", "First chat")], errors: []});
        native.selectMany.mockResolvedValueOnce({selections: [selected("a", "First chat"), selected("b", "Claude chat", "claude")], errors: []});
        render(<ChatImportPanel native={native}/>);
        fireEvent.click(screen.getByRole("button", { name: "Choose transcripts" })); await screen.findByText("First chat prompt");
        fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
        fireEvent.click(screen.getByRole("button", { name: "Choose transcripts" })); await screen.findByText("Claude chat prompt");
        expect(native.selectMany.mock.calls[1]?.[0]).toBe("claude");
        expect(screen.getAllByText("First chat prompt")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "Remove First chat" }));
        expect(screen.queryByText("First chat prompt")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Import private Chat" }));
        await waitFor(() => expect(native.apply).toHaveBeenCalledWith("b", "Claude chat", expect.any(AbortSignal), expect.any(Function)));
    });
});
