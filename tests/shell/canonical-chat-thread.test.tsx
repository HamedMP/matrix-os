// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatInvalidation } from "@matrix-os/ui";
import { useCanonicalChatThread } from "../../shell/src/hooks/useCanonicalChatThread.js";
import { BrainApp } from "../../shell/src/components/brain/index.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import { ChatProvider } from "../../shell/src/stores/chat-context.js";
import type { ChatState } from "../../shell/src/hooks/useChatState.js";
import type { CanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client.js";

vi.mock("@clerk/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const BOT_SELECTION = { instanceId: "matrix_bot_default", model: "auto" };

function record(id: string, revision = 0) {
  return {
    chat: {
      id, ownerScope: { type: "personal" as const, ownerId: "owner_shell" }, title: "What changed", revision,
      lifecycle: "active" as const, attention: "none" as const, messageCount: revision,
      createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
    },
  };
}
function message(chatId: string, id: string, text: string, seq = 1) {
  return { id, chatId, seq, role: "assistant" as const, state: "committed" as const, parts: [{ type: "text" as const, text }],
    createdAt: "2026-10-08T00:00:00.000Z" };
}
function detail(chatId: string, revision: number, text: string) {
  return { record: record(chatId, revision), messages: [message(chatId, "msg_1", text)], turns: [], runs: [], activities: [] };
}

function fakeEvents() {
  const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
  return {
    subscribe: vi.fn((listener: (event: CanonicalChatInvalidation) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }),
    subscribeConnectionState: vi.fn(() => ({ dispose: () => undefined })),
    connectionState: vi.fn(() => "open" as const),
    emit: (event: CanonicalChatInvalidation) => { for (const listener of [...listeners]) listener(event); },
  };
}

function fakeClient(agents?: unknown) {
  return {
    agents,
    detail: vi.fn(async (chatId: string) => detail(chatId, 1, "Bot chats stay under AGENTS.")),
    admitTurn: vi.fn(async (chatId: string) => ({
      record: record(chatId, 1), message: message(chatId, "msg_user", "Why?"), turn: {}, run: {}, admission: "accepted",
    })),
    cancelRun: vi.fn(), updateReadState: vi.fn(),
  } as unknown as CanonicalShellChatClient & Record<"detail" | "admitTurn", ReturnType<typeof vi.fn>>;
}

const SEND = { instanceId: BOT_SELECTION.instanceId, model: BOT_SELECTION.model, interactionMode: "default", permissionMode: "default" };

beforeEach(() => {
  vi.spyOn(window.history, "pushState");
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useCanonicalChatThread", () => {
  it("makes the Chat once on a draft's first send, then admits the turn, without touching the URL", async () => {
    const client = fakeClient();
    const createChat = vi.fn(async () => record("chat_new"));
    const onChatChanged = vi.fn();
    const events = fakeEvents();
    const { result } = renderHook(() => useCanonicalChatThread({
      client, eventSource: events, chatId: null, createChat, onChatChanged,
    }));
    expect(result.current.sessionId).toBeUndefined();
    expect(client.detail).not.toHaveBeenCalled();
    let sent: unknown[] = [];
    await act(async () => {
      sent = await Promise.all([
        result.current.onSubmit("Why do Bot chats stay out of Project lists?", undefined, { ...SEND, clientRequestId: "req_first" }),
        result.current.onSubmit("Why do Bot chats stay out of Project lists?", undefined, SEND),
      ]);
    });
    expect(sent).toEqual([true, false]);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat).toHaveBeenCalledWith({ clientRequestId: "req_first_chat", title: "Why do Bot chats stay out of Project lists" });
    expect(client.admitTurn).toHaveBeenCalledWith("chat_new", expect.objectContaining({
      clientRequestId: "req_first", baseRevision: 0, selection: BOT_SELECTION,
      parts: [{ type: "text", text: "Why do Bot chats stay out of Project lists?" }],
    }));
    // Reported after the admitted turn, like every later turn, so a host list sorts and dates it.
    expect(onChatChanged).toHaveBeenCalledWith("chat_new", "What changed");
    expect(result.current.sessionId).toBe("chat_new");
    await waitFor(() => expect(result.current.messages.map((item) => item.content)).toEqual(["Bot chats stay under AGENTS."]));
    await act(async () => { await result.current.onSubmit("And then?", undefined, SEND); });
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(onChatChanged).toHaveBeenCalledTimes(2);
    expect(window.history.pushState).not.toHaveBeenCalled();
  });

  it("reports nothing when the turn after a new Chat fails, but keeps showing that Chat", async () => {
    const client = fakeClient();
    client.admitTurn.mockRejectedValueOnce(new Error("offline"));
    const onChatChanged = vi.fn();
    const events = fakeEvents();
    const createChat = vi.fn(async () => record("chat_new"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderHook(() => useCanonicalChatThread({
      client, eventSource: events, chatId: null, createChat, onChatChanged,
    }));
    await act(async () => { await result.current.onSubmit("Why?", undefined, SEND); });
    expect(onChatChanged).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBe("chat_new");
  });

  it("applies streamed content, falls back to a snapshot on a gap, and ignores other Chats", async () => {
    const client = fakeClient();
    const events = fakeEvents();
    const { result } = renderHook(() => useCanonicalChatThread({
      client, eventSource: events, chatId: "chat_a", createChat: vi.fn(),
    }));
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("Bot chats stay under AGENTS."));
    const content = (revision: number, text: string) => ({
      type: "chat.content" as const,
      event: { cursor: revision, revision, chatId: "chat_a", eventType: "run.message" as const, createdAt: "2026-10-08T00:00:01.000Z" },
      content: { record: record("chat_a", revision), messages: [message("chat_a", "msg_1", text)] },
    });
    act(() => events.emit({ type: "chat.changed", chatId: "chat_a", cursor: 2, revision: 2, eventType: "run.message", content: content(2, "Streamed") } as CanonicalChatInvalidation));
    expect(result.current.messages[0]?.content).toBe("Streamed");
    expect(client.detail).toHaveBeenCalledTimes(1);
    act(() => events.emit({ type: "chat.changed", chatId: "chat_other", cursor: 3, revision: 9, eventType: "run.message" }));
    expect(client.detail).toHaveBeenCalledTimes(1);
    client.detail.mockResolvedValueOnce(detail("chat_a", 5, "From the snapshot"));
    act(() => events.emit({ type: "chat.changed", chatId: "chat_a", cursor: 4, revision: 5, eventType: "run.message", content: content(5, "Gap") } as CanonicalChatInvalidation));
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("From the snapshot"));
    expect(client.detail).toHaveBeenCalledTimes(2);
  });
});

/** The Web Brain app over a fake gateway: one project with a repository, and a Company Brain Bot. */
function webBrain(items: unknown[] = [], connected = true) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(String(url).includes("/sources")
    ? { items: [{ sourceId: "src_git", kind: "git" }], kinds: [] }
    : { projects: [{ id: "proj_matrix_os", name: "matrix-os", slug: "matrix-os" }] })));
  const bot = { id: "bot_brain0001", name: "Company Brain", revision: 1, instructions: "Short.", description: "Brain",
    archived: false, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
    selection: BOT_SELECTION, recipeRef: { recipeId: "company-brain", version: "1" } };
  const threads = { list: vi.fn(async () => ({ items })), create: vi.fn(async () => record("chat_brain")) };
  const agents = { list: vi.fn(async () => ({ enabled: true, agents: [bot] })), bots: {
    threads, interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => { throw new Error("offline"); }), directBot: vi.fn(async () => bot.id),
  } };
  const client = fakeClient(agents);
  const switchConversation = vi.fn();
  const chat = { chatRuntime: { client, eventSource: fakeEvents() }, switchConversation, connected } as unknown as ChatState;
  render(<ChatProvider value={chat}><BrainApp showHeading={false} /></ChatProvider>);
  return { bot, threads, agents, client, switchConversation };
}

describe("Company Brain chat on Web", () => {
  it("hosts the shell chat view with no rail, chips or chrome, sends a draft as a brain thread and opens it in Chat", async () => {
    const openWindow = vi.spyOn(useWindowManager.getState(), "openWindow").mockImplementation(() => undefined as never);
    const { bot, threads, agents, client, switchConversation } = webBrain();

    expect(await screen.findByRole("heading", { name: "Ask about matrix-os" })).toBeTruthy();
    expect(screen.getByText("Answers come only from this project's brain, with a link to every source.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close Chat sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Chat sidebar" })).toBeNull();
    // The same screen as Electron's brain tab: no generic chips the Bot cannot do, and no settings or Share.
    expect(screen.queryByText("What can you do?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Agents & providers settings" })).toBeNull();
    expect(agents.bots.directBot).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: /message/i }), { target: { value: "What changed this week?" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith("chat_brain", expect.objectContaining({ selection: BOT_SELECTION })));
    expect(threads.create).toHaveBeenCalledWith(bot.id, expect.objectContaining({ projectId: "proj_matrix_os", title: "What changed this week" }));

    await waitFor(() => expect(screen.getByText("Bot chats stay under AGENTS.")).toBeTruthy());
    expect(screen.queryByText("What can you do?")).toBeNull();

    const open = await screen.findByRole("button", { name: "Open in Chat" });
    fireEvent.click(open);
    expect(switchConversation).toHaveBeenCalledWith("chat_brain");
    expect(openWindow).toHaveBeenCalledWith("Chat", "__chat__", expect.any(Number));
    expect(within(screen.getByRole("tablist")).getByRole("tab", { selected: true })).toHaveTextContent("Chat");
  });

  it("on Web Canvas, Open in Chat brings the Chat window back and pans the view to it", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 0; });
    const focusOnWindow = vi.spyOn(useCanvasTransform.getState(), "focusOnWindow").mockImplementation(() => undefined);
    useDesktopMode.getState().setMode("canvas");
    act(() => { useWindowManager.getState().openWindow("Chat", "__chat__", 20); });
    const chatWindow = useWindowManager.getState().windows.find((win) => win.path === "__chat__")!;
    act(() => { useWindowManager.getState().minimizeWindow(chatWindow.id); });
    try {
      const { switchConversation } = webBrain([record("chat_old", 1)], false);
      fireEvent.click(await screen.findByRole("button", { name: "Open in Chat" }));
      expect(screen.queryByText("Offline")).toBeNull();
      expect(switchConversation).toHaveBeenCalledWith("chat_old");
      expect(useWindowManager.getState().getWindow(chatWindow.id)?.minimized).toBe(false);
      expect(focusOnWindow).toHaveBeenCalledWith(expect.objectContaining({ id: chatWindow.id }), expect.any(Number), expect.any(Number));
      expect(useWindowManager.getState().windows.filter((win) => win.path === "__chat__")).toHaveLength(1);
    } finally {
      useDesktopMode.getState().setMode("desktop");
      act(() => { useWindowManager.getState().closeWindow(chatWindow.id); });
    }
  });
});
