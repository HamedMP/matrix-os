// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatNavigationItem, CanonicalChatRecord } from "@matrix-os/contracts";
import { createChatNavigationStore } from "@matrix-os/ui";
import type { useShellChatNavigation } from "../../shell/src/hooks/useChatNavigation";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const state = vi.hoisted(() => ({ navigation: {} as ReturnType<typeof useShellChatNavigation> }));
vi.mock("../../shell/src/hooks/useChatNavigation", () => ({ useShellChatNavigation: () => state.navigation }));
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
    state.navigation = { ...state.navigation, items: [...state.navigation.items] };
    hook.rerender({ scope: "owner/runtime/main" });
    await waitFor(() => expect(hook.result.current.messages.some(message => message.content === "Unread Chats could not be refreshed. Try again.")).toBe(true));
    expect(hook.result.current.conversations.map(value => value.id)).toEqual(["chat_older"]);
    const dispose = vi.spyOn(state.navigation.store!, "dispose");
    unreadFetch.mockResolvedValueOnce(Response.json({ error: { code: "unauthorized" } }, { status: 403 }));
    state.navigation = { ...state.navigation, items: [...state.navigation.items] };
    hook.rerender({ scope: "owner/runtime/main" });
    await waitFor(() => expect(hook.result.current.conversations).toEqual([]));
    expect(dispose).toHaveBeenCalledWith(true);
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
