// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/ChatApp";
import { DesktopWindow } from "@/components/desktop/DesktopWindow";
import { MobileShell } from "@/components/mobile/MobileShell";
import { CanvasWindow } from "@/components/canvas/CanvasWindow";
import { ChatProvider } from "@/stores/chat-context";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
import type { ChatState } from "@/hooks/useChatState";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

vi.mock("@clerk/nextjs", async (original) => ({
  ...(await original<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("@/components/Settings", () => ({ Settings: () => null }));
vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: () => {} }));
vi.mock("@/components/AppViewer", () => ({ AppViewer: () => null }));
vi.mock("@/components/terminal/TerminalApp", () => ({ TerminalApp: () => null }));
vi.mock("@/components/file-browser/FileBrowser", () => ({ FileBrowser: () => null }));
vi.mock("@/components/PreviewWindow", () => ({ PreviewWindow: () => null }));
const win: AppWindow = {
  id: "win-chat", title: "Chat", path: "__chat__", x: 20, y: 30,
  width: 640, height: 420, minimized: false, zIndex: 1,
};
const source = { kind: "chat" as const, id: "chat_notes", label: "Meeting notes" };
function chatState(): ChatState {
  return {
    messages: [{ id: "msg_original", role: "user", content: "Original request", timestamp: 1000 }],
    sessionId: "chat_original", activeRunId: "run_matrix_pi", busy: true, connected: true,
    currentTool: null, queue: [], conversations: [], composerDraftRequest: null,
    requestComposerDraft: vi.fn(), consumeComposerDraft: vi.fn(),
    submitMessage: vi.fn(async () => true), newChat: vi.fn(async () => {}),
    switchConversation: vi.fn(), abortCurrent: vi.fn(),
    agentClient: {
      list: vi.fn(async () => ({ enabled: true, agents: [] })),
      search: vi.fn(async () => ({ enabled: true, resources: [source] })),
      catalog: vi.fn(), create: vi.fn(), update: vi.fn(), preview: vi.fn(),
    },
  };
}
function renderWindow(surface: "Web Desktop" | "Web Canvas", chat: ChatState) {
  const noop = vi.fn();
  return render(surface === "Web Canvas"
    ? <ChatProvider value={chat}><CanvasWindow win={win} /></ChatProvider>
    : <DesktopWindow win={win} chat={chat} dockPosition="bottom" fullscreenWindowId={null}
        interacting={false} minimizingIds={new Set()} onAnimateMinimize={noop}
        onCloseWindow={noop} onDragEnd={noop} onDragMove={noop} onDragStart={noop}
        onFocusWindow={noop} onOpenWindow={noop} onResizeInteractionChange={noop} onToggleFullscreen={noop} />);
}
function renderChat(chat: ChatState, mobile = false) {
  return render(<ChatApp messages={chat.messages} sessionId={chat.sessionId} busy={chat.busy}
    activeRunId={chat.activeRunId} onAbortCurrent={chat.abortCurrent} connected={chat.connected}
    conversations={chat.conversations} onNewChat={chat.newChat} onSwitchConversation={chat.switchConversation}
    onSubmit={chat.submitMessage} agentClient={chat.agentClient} queuedTurns={chat.queuedTurns} mobile={mobile} />);
}
beforeEach(() => {
  window.localStorage.clear();
  useWindowManager.setState({ windows: [win], focusedWindowId: win.id, fullscreenWindowId: null });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/system/info")) return Response.json({ runtime: { handle: null, runtimeSlot: "primary" } });
    if (url.includes("/api/shell/bootstrap")) return Response.json([]);
    return Response.json(createCanonicalProviderCatalogFixture());
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("shared Web Chat run cancellation", () => {
  it.each(["Web Desktop", "Web Canvas"] as const)("%s stops the active run once without submitting or clearing the draft", async (surface) => {
    const chat = chatState();
    renderWindow(surface, chat);
    const editor = screen.getByRole("textbox", { name: "Message chat" });
    fireEvent.change(editor, { target: { value: "Keep this draft" } });
    const stop = await screen.findByRole("button", { name: "Stop", exact: true });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stop);
    expect(chat.abortCurrent).toHaveBeenCalledOnce();
    expect(chat.submitMessage).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("Keep this draft");
  });
  it.each(["Web Desktop", "Web Canvas"] as const)("%s can stop an existing run when the provider becomes unavailable", async (surface) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/system/info")
      ? Response.json({ runtime: { handle: null, runtimeSlot: "primary" } })
      : Response.json(createCanonicalProviderCatalogFixture("unavailable"))));
    const chat = chatState();
    renderWindow(surface, chat);
    const stop = await screen.findByRole("button", { name: "Stop", exact: true });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message chat" }).getAttribute("placeholder")).toContain("connect a harness to send"));
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stop);
    expect(chat.abortCurrent).toHaveBeenCalledOnce();
  });
  it.each(["admission", "loading", "queued-only"])("does not offer Stop for %s without an active run", async (state) => {
    const chat = chatState();
    chat.activeRunId = undefined;
    if (state === "queued-only") {
      chat.busy = false;
      chat.queuedTurns = [{
      id: "cqturn_notes", chatId: "chat_original", clientRequestId: "req_notes", position: 1,
      parts: [{ type: "text", text: "Use the notes later" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default", permissionMode: "supervised",
      createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
      }];
    }
    renderChat(chat);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: "Stop", exact: true })).toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(chat.abortCurrent).not.toHaveBeenCalled();
  });
  it("keeps Stop separate from Queue next for referenced Agent requests", async () => {
    const chat = chatState();
    renderChat(chat);
    const editor = screen.getByRole("textbox", { name: "Message chat" });
    fireEvent.change(editor, { target: { value: "@mee" } });
    fireEvent.click(await screen.findByRole("option", { name: /Meeting notes/ }));
    fireEvent.change(editor, { target: { value: "Continue using the notes" } });
    const queue = screen.getByRole("button", { name: "Queue next" });
    expect((queue as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Stop", exact: true }));
    expect(chat.abortCurrent).toHaveBeenCalledOnce();
    expect(chat.submitMessage).not.toHaveBeenCalled();
    fireEvent.click(queue);
    await waitFor(() => expect(chat.submitMessage).toHaveBeenCalledOnce());
    expect(vi.mocked(chat.submitMessage).mock.calls[0]?.[2]).toMatchObject({ resources: [source] });
  });
  it("shares the active-run Stop action with the Web Mobile renderer", async () => {
    const chat = chatState();
    render(<ChatProvider value={chat}><MobileShell launchAppPath="__chat__" /></ChatProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Stop", exact: true }));
    expect(chat.abortCurrent).toHaveBeenCalledOnce();
  });
});
