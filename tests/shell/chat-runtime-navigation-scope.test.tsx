// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import { clearChatNavigationScopes, createBrowserChatNavigationPersistence } from "@matrix-os/ui";
import { createShellChatNavigationScope } from "../../shell/src/lib/chat-navigation-scope";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
const snapshot: CanonicalChatNavigationResponse = { version: 1, truncated: false, items: [{
  chat: { id: "chat_main", title: "Main Chat", revision: 1, lifecycle: "active", attention: "none", messageCount: 0,
    createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" },
  readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 },
  classification: { kind: "ordinary" }, persistence: "personal",
}] };
function mount() {
  return renderHook(() => useCanonicalChatState({
    navigationScope: createShellChatNavigationScope({ userId: "user_1" }, "session_1"),
    navigationGeneration: "session_1",
  }));
}
afterEach(() => {
  cleanup(); clearChatNavigationScopes(); localStorage.clear(); vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

it.each(["memory", "disk"])("does not restore another runtime's %s Chat list or selection while loading or failing", async source => {
  let fail!: (value: Response) => void;
  const review = new Promise<Response>(resolve => { fail = resolve; });
  const fetcher = vi.fn(async (input: string) => {
    if (input.includes("/~runtime/review/api/chat-navigation?")) return review;
    if (input.includes("/api/chat-navigation?")) return Response.json(snapshot);
    if (input.includes("/events?")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetcher);
  window.history.replaceState({}, "", "/vm/alice");
  const mainScope = createShellChatNavigationScope({ userId: "user_1" }, "session_1")!;
  if (source === "disk") {
    await createBrowserChatNavigationPersistence(localStorage, mainScope).save(snapshot);
  } else {
    const main = mount();
    await waitFor(() => expect(main.result.current.sessionId).toBe("chat_main"));
    main.unmount();
  }
  window.history.replaceState({}, "", "/vm/alice?runtime=review");
  const selected = mount();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("/~runtime/review/api/chat-navigation?"))).toBe(true));
  expect(selected.result.current.conversations).toEqual([]);
  expect(selected.result.current.sessionId).toBeUndefined();
  await act(async () => fail(Response.json({ error: { code: "unavailable" } }, { status: 503 })));
  expect(selected.result.current.conversations).toEqual([]);
  expect(selected.result.current.sessionId).toBeUndefined();
  expect(selected.result.current.messages.some(message => message.content === "Chats could not be loaded. Try again.")).toBe(true);
});

it("keeps unverified and self-hosted viewers memory-only", () => {
  expect(createShellChatNavigationScope(null, "session_1")).toBeUndefined();
  expect(createShellChatNavigationScope({ userId: "user_1" }, null)).toBeUndefined();
});
