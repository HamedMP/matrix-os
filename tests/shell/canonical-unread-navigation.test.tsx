// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatNavigationItem, CanonicalChatRecord } from "@matrix-os/contracts";
import { createChatNavigationStore, type CanonicalChatInvalidation } from "@matrix-os/ui";
import type { useShellChatNavigation } from "../../shell/src/hooks/useChatNavigation";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const state = vi.hoisted(() => ({ navigation: {} as ReturnType<typeof useShellChatNavigation>, listeners: [] as Array<(event: CanonicalChatInvalidation) => void> }));
vi.mock("../../shell/src/hooks/useChatNavigation", () => ({ useShellChatNavigation: () => state.navigation }));
vi.mock("@matrix-os/ui", async importOriginal => ({
  ...await importOriginal<typeof import("@matrix-os/ui")>(),
  createSharedCanonicalChatEventSource: () => ({
    subscribe: (listener: (event: CanonicalChatInvalidation) => void) => {
      state.listeners.push(listener);
      return { dispose: () => { state.listeners = state.listeners.filter(value => value !== listener); } };
    },
    subscribeConnectionState: () => ({ dispose() {} }),
    connectionState: () => "open",
    start: async () => {}, dispose() {},
  }),
}));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
function record(id: string, unread = true): CanonicalChatRecord {
  const { chat: { project, activeRun, providerBinding, ...chat } } = createCanonicalChatFixture("completed").snapshot;
  return { chat: { ...chat, id, title: id }, projectId: project?.projectId, activeRun, providerBinding,
    readState: { version: 1, unread, markedUnread: unread, latestIncomingSeq: 1, readThroughSeq: unread ? 0 : 1 } };
}
function item(id: string, unread = true): CanonicalChatNavigationItem {
  const value = record(id, unread);
  return { ...value, readState: value.readState!, classification: { kind: "ordinary" }, persistence: "personal" };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
let unreadFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.listeners = [];
  state.navigation = { items: [item("chat_recent", false)], truncated: false, fresh: true, status: "ready", updatedAt: 1, error: null,
    store: createChatNavigationStore({ load: async () => ({ version: 1, items: [], truncated: false }) }) };
  unreadFetch = vi.fn(async () => Response.json({ items: [record("chat_older")] }));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.includes("/events?")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    if (input.includes("/api/chats?") && input.includes("unread=true")) return unreadFetch(input);
    if (input.includes("/api/chat-agents")) return Response.json({ enabled: true, agents: [] });
    if (input.includes("/chat_unknown/bot?")) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    if (input.includes("/bot?")) return Response.json({ agentId: input.includes("chat_bot") ? "bot_12345678" : null });
    return Response.json({ error: { code: "unavailable" } }, { status: 503 });
  }));
});
afterEach(() => { cleanup(); state.navigation.store.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = () => renderHook(({ scope }) => useCanonicalChatState({ initialDraft: "unsent", navigationScope: scope }), { initialProps: { scope: "owner/runtime/main" } });

describe("Web unread navigation", () => {
  it("reuses a complete navigation snapshot without scoped reads", async () => {
    state.navigation.items.push(item("chat_unread"));
    const hook = mount();
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    expect(hook.result.current.conversations.map(value => value.id)).toEqual(["chat_unread"]);
    expect(unreadFetch).not.toHaveBeenCalled();
  });
  it("loads unread history outside a truncated 1000-row window atomically and classifies Bots", async () => {
    state.navigation.truncated = true;
    state.navigation.items = Array.from({ length: 1000 }, (_, index) => item(`chat_recent_${index}`, false));
    const second = deferred<Response>();
    unreadFetch.mockResolvedValueOnce(Response.json({ items: [record("chat_older")], nextCursor: "chatcur_next_page" })).mockImplementationOnce(() => second.promise);
    const hook = mount();
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    await waitFor(() => expect(unreadFetch).toHaveBeenCalledTimes(2));
    expect(hook.result.current.conversations).toEqual([]);
    await act(async () => second.resolve(Response.json({ items: [record("chat_oldest"), record("chat_bot"), record("chat_unknown")] })));
    await waitFor(() => expect(hook.result.current.conversations).toHaveLength(3));
    expect(hook.result.current.navigationClassifications).toContainEqual({ chatId: "chat_bot", classification: { kind: "bot", agentId: "bot_12345678" } });
    expect(hook.result.current.conversations.map(value => value.id)).toEqual(["chat_older", "chat_oldest", "chat_bot"]);
    expect(unreadFetch.mock.calls[1][0]).toContain("cursor=chatcur_next_page");
  });
  it("discards pending unread history after authority replacement", async () => {
    state.navigation.truncated = true;
    const pending = deferred<Response>();
    unreadFetch.mockImplementationOnce(() => pending.promise);
    const hook = mount();
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    await waitFor(() => expect(unreadFetch).toHaveBeenCalledOnce());
    state.navigation = { ...state.navigation, truncated: false, items: [] };
    hook.rerender({ scope: "other/runtime/main" });
    await act(async () => pending.resolve(Response.json({ items: [record("chat_private")] })));
    expect(hook.result.current.conversations).toEqual([]);
  });
  it("retains verified unread rows on transient refresh failure and clears them on revocation", async () => {
    state.navigation.truncated = true;
    const hook = mount();
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    await waitFor(() => expect(hook.result.current.conversations.map(value => value.id)).toEqual(["chat_older"]));
    unreadFetch.mockResolvedValueOnce(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    state.navigation = { ...state.navigation, updatedAt: state.navigation.updatedAt + 1, items: [...state.navigation.items] };
    hook.rerender({ scope: "owner/runtime/main" });
    await waitFor(() => expect(hook.result.current.messages.some(message => message.content === "Unread Chats could not be refreshed. Try again.")).toBe(true));
    expect(hook.result.current.conversations.map(value => value.id)).toEqual(["chat_older"]);
    const revoke = vi.spyOn(state.navigation.store!, "revoke");
    unreadFetch.mockResolvedValueOnce(Response.json({ error: { code: "unauthorized" } }, { status: 403 }));
    state.navigation = { ...state.navigation, updatedAt: state.navigation.updatedAt + 1, items: [...state.navigation.items] };
    hook.rerender({ scope: "owner/runtime/main" });
    await waitFor(() => expect(hook.result.current.conversations).toEqual([]));
    expect(revoke).toHaveBeenCalledOnce();
  });
  it("bounds a server's repeated unread cursor and cancels results when the filter closes", async () => {
    state.navigation.truncated = true;
    // Return fresh response bodies for both pages.
    unreadFetch.mockImplementation(async () => Response.json({ items: [record("chat_older")], nextCursor: "chatcur_repeat" }));
    const hook = mount();
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    await waitFor(() => expect(hook.result.current.conversations).toHaveLength(1));
    expect(unreadFetch).toHaveBeenCalledTimes(2);
    await act(async () => hook.result.current.setUnreadOnly?.(false));
    const pending = deferred<Response>();
    unreadFetch.mockImplementationOnce(() => pending.promise);
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    await waitFor(() => expect(unreadFetch).toHaveBeenCalledTimes(3));
    await act(async () => hook.result.current.setUnreadOnly?.(false));
    await act(async () => pending.resolve(Response.json({ items: [record("chat_late")] })));
    expect(hook.result.current.conversations.map(value => value.id)).toEqual(["chat_recent"]);
  });
  it("finishes older unread pagination during stream deltas and keeps local known-row updates", async () => {
    state.navigation.truncated = true;
    unreadFetch.mockResolvedValueOnce(Response.json({ items: [record("chat_known")] }));
    const hook = mount();
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    await waitFor(() => expect(hook.result.current.conversations).toHaveLength(1));
    const older = deferred<Response>();
    unreadFetch.mockResolvedValueOnce(Response.json({ items: [record("chat_known")], nextCursor: "chatcur_older" }))
      .mockImplementationOnce(() => older.promise);
    state.navigation = { ...state.navigation, updatedAt: 2, items: [...state.navigation.items] };
    hook.rerender({ scope: "owner/runtime/main" });
    await waitFor(() => expect(unreadFetch).toHaveBeenCalledTimes(3));
    for (let index = 0; index < 4; index++) {
      const value = record(index % 2 ? "chat_absent" : "chat_known");
      value.chat = { ...value.chat, title: "Streaming title", titleVersion: 10, revision: 10 };
      const event = { cursor: index + 1, chatId: value.chat.id, revision: 10, eventType: "run.message" as const, createdAt: value.chat.createdAt };
      await act(async () => {
        for (const listener of [...state.listeners]) listener({ type: "chat.changed", ...event,
          content: { type: "chat.content", event, content: { record: value } } });
      });
      // Local global-store updates replace the array without a server refresh.
      state.navigation = { ...state.navigation, items: [...state.navigation.items] };
      hook.rerender({ scope: "owner/runtime/main" });
    }
    expect(unreadFetch).toHaveBeenCalledTimes(3);
    expect(hook.result.current.conversations[0]?.title).toBe("Streaming title");
    await act(async () => older.resolve(Response.json({ items: [record("chat_oldest")] })));
    await waitFor(() => expect(hook.result.current.conversations.map(value => value.id)).toEqual(["chat_known", "chat_oldest"]));
    expect(hook.result.current.conversations[0]?.title).toBe("Streaming title");
    expect(unreadFetch).toHaveBeenCalledTimes(3);
    await act(async () => {
      for (const listener of [...state.listeners]) listener({ type: "chat.full_refresh", cursor: 20 });
    });
    await waitFor(() => expect(unreadFetch).toHaveBeenCalledTimes(4));
  });
  it("refreshes unread membership for non-stream content and applies read-state changes immediately", async () => {
    state.navigation.truncated = true;
    unreadFetch.mockResolvedValueOnce(Response.json({ items: [record("chat_known")] }));
    const hook = mount();
    await act(async () => hook.result.current.setUnreadOnly?.(true));
    await waitFor(() => expect(hook.result.current.conversations).toHaveLength(1));
    const refreshed = deferred<Response>();
    unreadFetch.mockImplementationOnce(() => refreshed.promise);
    const value = record("chat_known", false);
    value.readState = { ...value.readState!, version: 2 };
    const event = { cursor: 1, chatId: value.chat.id, revision: value.chat.revision, eventType: "chat.updated" as const, createdAt: value.chat.createdAt };
    await act(async () => {
      for (const listener of [...state.listeners]) listener({ type: "chat.changed", ...event,
        content: { type: "chat.content", event, content: { record: value } } });
    });
    expect(hook.result.current.conversations).toEqual([]);
    await waitFor(() => expect(unreadFetch).toHaveBeenCalledTimes(2));
    await act(async () => refreshed.resolve(Response.json({ items: [record("chat_newly_unread")] })));
    await waitFor(() => expect(hook.result.current.conversations.map(item => item.id)).toEqual(["chat_newly_unread"]));
  });
  it("removes a recovered navigation error without erasing an unrelated detail error", async () => {
    state.navigation.error = "Chats could not be refreshed. Try again.";
    const hook = mount();
    expect(hook.result.current.messages.some(message => message.content === state.navigation.error)).toBe(true);
    state.navigation = { ...state.navigation, error: null };
    hook.rerender({ scope: "owner/runtime/main" });
    expect(hook.result.current.messages).toEqual([]);
    await act(async () => hook.result.current.switchConversation("chat_bad"));
    await waitFor(() => expect(hook.result.current.messages.some(message => message.content === "Chat could not be loaded. Try again.")).toBe(true));
    state.navigation = { ...state.navigation, error: "Chats could not be refreshed. Try again." };
    hook.rerender({ scope: "owner/runtime/main" });
    state.navigation = { ...state.navigation, error: null };
    hook.rerender({ scope: "owner/runtime/main" });
    expect(hook.result.current.messages.some(message => message.content === "Chat could not be loaded. Try again.")).toBe(true);
  });
});
