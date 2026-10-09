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
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <div data-testid="harness-setup">{children}</div>,
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
    // The draft's composer lets the question go: it moves to the new Chat's composer.
    await act(async () => { expect(await result.current.onSubmit("Why?", undefined, SEND)).toBe(true); });
    expect(onChatChanged).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBe("chat_new");
    // The new Chat's composer gets the question back once, so a refused first send loses nothing.
    const returned = result.current.composerDraftRequest;
    expect(returned).toMatchObject({ text: "Why?" });
    act(() => result.current.onComposerDraftConsumed(returned!.id));
    expect(result.current.composerDraftRequest).toBeNull();
    // A refused turn in a Chat that already existed keeps its question in the same composer, so nothing comes back.
    client.admitTurn.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { expect(await result.current.onSubmit("And then?", undefined, SEND)).toBe(false); });
    expect(result.current.composerDraftRequest).toBeNull();
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

  it("queues a question with a Chat reference behind a running answer, like the Chat app, and keeps a retry queued", async () => {
    const client = fakeClient();
    const queued = { id: "qturn_next", chatId: "chat_a", clientRequestId: "req_next", position: 1,
      parts: [{ type: "text" as const, text: "And the tests?" }], selection: BOT_SELECTION, interactionMode: "default",
      permissionMode: "default", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z" };
    client.detail.mockResolvedValue({ ...detail("chat_a", 2, "Thinking"), record: { ...record("chat_a", 2), activeRun: { runId: "run_1" } } });
    const queueTurn = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ queuedTurn: queued, queueDepth: 1, alreadyClaimed: false });
    Object.assign(client, { queueTurn });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = fakeEvents();
    const { result } = renderHook(() => useCanonicalChatThread({ client, eventSource: events, chatId: "chat_a", createChat: vi.fn() }));
    await waitFor(() => expect(result.current.activeRunId).toBe("run_1"));
    const resource = { kind: "chat" as const, id: "chat_notes", label: "Notes" };
    const ask = () => result.current.onSubmit("And the tests?", undefined, { ...SEND, clientRequestId: "req_next", resources: [resource] });
    let sent: unknown;
    await act(async () => { sent = await ask(); });
    expect(sent).toBe(false);
    // The answer ends before the retry; the question may already be queued, so the retry goes to the same queue.
    client.detail.mockResolvedValue({ ...detail("chat_a", 3, "Done"), queuedTurns: [queued] });
    act(() => events.emit({ type: "chat.changed", chatId: "chat_a", cursor: 3, revision: 3, eventType: "run.completed" } as CanonicalChatInvalidation));
    await waitFor(() => expect(result.current.activeRunId).toBeUndefined());
    await act(async () => { sent = await ask(); });
    expect(sent).toBe(true);
    expect(client.admitTurn).not.toHaveBeenCalled();
    expect(queueTurn).toHaveBeenCalledTimes(2);
    expect(queueTurn).toHaveBeenLastCalledWith("chat_a", expect.objectContaining({ clientRequestId: "req_next",
      parts: [{ type: "text", text: "And the tests?" }, { type: "resource_reference", resource }] }));
    expect(queueTurn.mock.calls[0]?.[1]).toMatchObject({ clientRequestId: "req_next", baseRevision: 2 });
    expect(result.current.queuedTurns).toEqual([queued]);
  });

  it("without a stream, polls a running answer one snapshot at a time", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const running = { ...detail("chat_a", 1, "Thinking"), record: { ...record("chat_a", 1), activeRun: { runId: "run_1" } } };
      client.detail.mockResolvedValueOnce(running).mockImplementation(() => new Promise(() => undefined));
      const events = { ...fakeEvents(), connectionState: vi.fn(() => "reconnecting" as const) };
      const { result } = renderHook(() => useCanonicalChatThread({ client, eventSource: events, chatId: "chat_a", createChat: vi.fn() }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.busy).toBe(true);
      expect(client.detail).toHaveBeenCalledTimes(1);
      // The snapshot never answers: no second poll starts while it is in flight.
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(client.detail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The Web Brain app over a fake gateway: one project with a repository, and a Company Brain Bot. */
function webBrain(items: unknown[] = [], connected = true, windowState = { active: true, visible: true }) {
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
  const view = (state: typeof windowState) => <ChatProvider value={chat}><BrainApp showHeading={false} {...state} /></ChatProvider>;
  const { rerender } = render(view(windowState));
  return { bot, threads, agents, client, switchConversation, rerender: (state: typeof windowState) => rerender(view(state)) };
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

  it("shows no harness setup in a Bot's chat, and gives a refused first question back to the composer", async () => {
    const { client } = webBrain();
    client.admitTurn.mockRejectedValueOnce(new Error("provider_unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await screen.findByRole("heading", { name: "Ask about matrix-os" })).toBeTruthy();
    expect(screen.queryByTestId("harness-setup")).toBeNull();
    const composer = () => screen.getByRole("textbox", { name: /message/i });
    expect(composer().getAttribute("placeholder") ?? "").not.toMatch(/harness/);
    fireEvent.change(composer(), { target: { value: "Why did src/a.ts change?" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith("chat_brain", expect.anything()));
    await waitFor(() => expect(composer()).toHaveValue("Why did src/a.ts change?"));
    expect(screen.queryByTestId("harness-setup")).toBeNull();
    // The question now lives in its thread, so the next draft starts empty.
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(await screen.findByRole("heading", { name: "Ask about matrix-os" })).toBeTruthy();
    expect(composer()).toHaveValue("");
  });

  it("keeps an unfinished question in each brain thread and in the draft when the viewer switches threads", async () => {
    const titled = (id: string, title: string) => ({ ...record(id, 1), chat: { ...record(id, 1).chat, title } });
    webBrain([titled("chat_a", "Release notes"), titled("chat_b", "Test plan")]);
    const composer = () => screen.getByRole("textbox", { name: /message/i });
    const openRow = async (name: RegExp) => {
      fireEvent.click(await screen.findByRole("button", { name }));
      await waitFor(() => expect(screen.getByText("Bot chats stay under AGENTS.")).toBeTruthy());
    };
    await openRow(/^Release notes/);
    fireEvent.change(composer(), { target: { value: "What shipped in" } });
    await openRow(/^Test plan/);
    expect(composer()).toHaveValue("");
    fireEvent.change(composer(), { target: { value: "Which tests" } });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /message/i }), { target: { value: "Who owns" } });
    await openRow(/^Release notes/);
    expect(composer()).toHaveValue("What shipped in");
    await openRow(/^Test plan/);
    expect(composer()).toHaveValue("Which tests");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(await screen.findByRole("textbox", { name: /message/i })).toHaveValue("Who owns");
  });

  it("marks a brain answer read only while its window is focused, like the Chat window", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const unread = { unread: true, markedUnread: false, version: 3, readThroughSeq: 0, latestIncomingSeq: 1 };
    // A minimized (or unfocused) Brain window stays mounted, so its chat must not read the answer for the viewer.
    const { client, rerender } = webBrain([record("chat_old", 1)], true, { active: false, visible: false });
    client.detail.mockImplementation(async (chatId: string) => ({ ...detail(chatId, 1, "Answer"), record: { ...record(chatId, 1), readState: unread } }));
    const read = { ...unread, unread: false, version: 4, readThroughSeq: 1 };
    vi.mocked(client.updateReadState).mockImplementation(async (chatId: string) => ({ ...record(chatId, 1), readState: read }));
    expect(await screen.findByText("Answer")).toBeTruthy();
    // Let the shown answer's effects run before checking that nothing was read.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(client.updateReadState).not.toHaveBeenCalled();
    rerender({ active: true, visible: true });
    await waitFor(() => expect(client.updateReadState).toHaveBeenCalledWith("chat_old", { type: "mark_read", throughSeq: 1, baseVersion: 3 }));
  });

  it("cancels a queued brain question from the brain chat, then shows the queue without it", async () => {
    const { client } = webBrain([record("chat_old", 1)]);
    const queued = { id: "qturn_next", chatId: "chat_old", clientRequestId: "req_queued", position: 1,
      parts: [{ type: "text" as const, text: "And the tests?" }], selection: BOT_SELECTION, interactionMode: "default",
      permissionMode: "default", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z" };
    // Queued from another surface while an answer runs.
    client.detail.mockImplementation(async (chatId: string) => ({ ...detail(chatId, 2, "Answer"),
      record: { ...record(chatId, 2), activeRun: { runId: "run_1" } }, queuedTurns: [queued] }));
    const cancelQueuedTurn = vi.fn(async () => {
      client.detail.mockImplementation(async (chatId: string) => ({ ...detail(chatId, 3, "Answer"), queuedTurns: [] }));
      return { queuedTurnId: queued.id, queueDepth: 0, cancellation: "cancelled" as const };
    });
    Object.assign(client, { cancelQueuedTurn });
    const cancel = await screen.findByRole("button", { name: "Cancel queued request" });
    await waitFor(() => expect(cancel).toHaveProperty("disabled", false));
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelQueuedTurn).toHaveBeenCalledWith("chat_old", "qturn_next",
      { clientRequestId: expect.stringMatching(/^req_/), baseRevision: 2 }));
    await waitFor(() => expect(screen.queryByText("And the tests?")).toBeNull());
    expect(screen.queryByText("Queued request could not be cancelled. Try again.")).toBeNull();
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
