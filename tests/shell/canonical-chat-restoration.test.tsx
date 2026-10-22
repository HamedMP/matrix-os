// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clearChatNavigationScopes, createBrowserChatNavigationPersistence } from "@matrix-os/ui";
import type { CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
const scope = "user_restore/runtime/review";
function snapshot(ids: string[]): CanonicalChatNavigationResponse {
  return { version: 1, truncated: false, items: ids.map(id => ({
    chat: { id, title: id, revision: 1, lifecycle: "active", attention: "none", messageCount: 0,
      createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" },
    readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 },
    classification: { kind: "ordinary" }, persistence: "personal",
  })) };
}
function validDetail(id: string) {
  const source = snapshot([id]).items[0]!;
  return { record: { chat: { ...source.chat,
    ownerScope: { type: "personal", ownerId: "owner_shell" },
    currentSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
  }, readState: source.readState }, messages: [{ id: `msg_${id}`, chatId: id, seq: 1,
    role: "assistant", state: "committed", parts: [{ type: "text", text: "Cached transcript" }], createdAt: source.chat.createdAt,
  }], turns: [], runs: [], activities: [] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { cleanup(); clearChatNavigationScopes(); localStorage.clear(); vi.unstubAllGlobals(); });
async function setup() {
  await createBrowserChatNavigationPersistence(localStorage, scope).save(snapshot(["chat_deleted"]));
  const navigation = deferred<Response>();
  const staleDetail = deferred<Response>();
  const fetcher = vi.fn(async (input: string) => {
    if (input.includes("/api/chat-navigation?")) return navigation.promise;
    if (input.includes("/events?")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    if (input.includes("/api/chats/chat_deleted?")) return staleDetail.promise;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useCanonicalChatState({ navigationScope: scope, navigationGeneration: "session_1" }));
  await waitFor(() => expect(hook.result.current.sessionId).toBe("chat_deleted"));
  return { hook, navigation, staleDetail, fetcher };
}
it.each([{ ids: ["chat_current"] }, { ids: [] }])("repairs a cache-restored selection after fresh removal (replacement=$ids)", async ({ ids }) => {
  const { hook, navigation, staleDetail } = await setup();
  await act(async () => staleDetail.resolve(Response.json({ error: { code: "unavailable" } }, { status: 503 })));
  await waitFor(() => expect(hook.result.current.messages.some(message => message.content === "Chat could not be loaded. Try again.")).toBe(true));
  await act(async () => navigation.resolve(Response.json(snapshot(ids))));
  await waitFor(() => expect(hook.result.current.sessionId).toBe(ids[0]));
  expect(hook.result.current.messages).toEqual([]);
});
it.each(["failure", "success"])("ignores a late deleted-Chat detail %s after automatic replacement", async outcome => {
  const { hook, navigation, staleDetail } = await setup();
  await act(async () => navigation.resolve(Response.json(snapshot(["chat_current"]))));
  await waitFor(() => expect(hook.result.current.sessionId).toBe("chat_current"));
  await act(async () => staleDetail.resolve(outcome === "failure"
    ? Response.json({ error: { code: "not_found" } }, { status: 404 })
    : Response.json(validDetail("chat_deleted"))));
  expect(hook.result.current.sessionId).toBe("chat_current");
  expect(hook.result.current.messages).toEqual([]);
});
it("keeps a valid automatic selection outside a truncated window until canonical deletion is confirmed", async () => {
  const { hook, navigation, staleDetail } = await setup();
  await act(async () => navigation.resolve(Response.json({ ...snapshot(["chat_current"]), truncated: true })));
  expect(hook.result.current.sessionId).toBe("chat_deleted");
  await act(async () => staleDetail.resolve(Response.json({ error: { code: "not_found" } }, { status: 404 })));
  await waitFor(() => expect(hook.result.current.sessionId).toBe("chat_current"));
  expect(hook.result.current.messages).toEqual([]);
});
it("retains a successfully loaded cached Chat when truncated history excludes it", async () => {
  const { hook, navigation, staleDetail } = await setup();
  await act(async () => staleDetail.resolve(Response.json(validDetail("chat_deleted"))));
  await waitFor(() => expect(hook.result.current.busy).toBe(false));
  await act(async () => navigation.resolve(Response.json({ ...snapshot(["chat_current"]), truncated: true })));
  expect(hook.result.current.sessionId).toBe("chat_deleted");
  expect(hook.result.current.busy).toBe(false);
});
it("clears a loaded provisional transcript when the complete authoritative list is empty", async () => {
  const { hook, navigation, staleDetail } = await setup();
  await act(async () => staleDetail.resolve(Response.json(validDetail("chat_deleted"))));
  await waitFor(() => expect(hook.result.current.messages[0]?.content).toBe("Cached transcript"));
  await act(async () => navigation.resolve(Response.json(snapshot([]))));
  expect(hook.result.current.sessionId).toBeUndefined();
  expect(hook.result.current.messages).toEqual([]);
  expect(hook.result.current.busy).toBe(false);
});
it("preserves explicit outside-window selection and an intentional empty draft", async () => {
  const { hook, navigation } = await setup();
  await act(async () => hook.result.current.switchConversation("chat_explicit"));
  await act(async () => navigation.resolve(Response.json({ ...snapshot(["chat_current"]), truncated: true })));
  expect(hook.result.current.sessionId).toBe("chat_explicit");
  await act(async () => hook.result.current.newChat());
  hook.rerender();
  expect(hook.result.current.sessionId).toBeUndefined();
});
it("retains a cached selection while fresh navigation is unavailable", async () => {
  const { hook, navigation } = await setup();
  await act(async () => navigation.resolve(Response.json({ error: { code: "unavailable" } }, { status: 503 })));
  expect(hook.result.current.sessionId).toBe("chat_deleted");
});
it("does not cycle between multiple deleted cached Chats while fresh navigation is pending", async () => {
  await createBrowserChatNavigationPersistence(localStorage, scope).save(snapshot(["chat_deleted_a", "chat_deleted_b"]));
  let details = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.includes("/api/chat-navigation?")) return new Promise<Response>(() => {});
    if (input.includes("/events?")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    if (++details <= 2) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    return new Promise<Response>(() => {});
  }));
  const hook = renderHook(() => useCanonicalChatState({ navigationScope: scope, navigationGeneration: "session_1" }));
  await waitFor(() => expect(details).toBeGreaterThanOrEqual(2));
  expect(hook.result.current.sessionId).toBeUndefined();
  expect(details).toBe(2);
});
