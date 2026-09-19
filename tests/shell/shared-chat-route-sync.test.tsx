// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));

const scopeId = "10000000-0000-4000-8000-000000000001";
const record = {
  chat: {
    id: "chat_regular",
    ownerScope: { type: "personal", ownerId: "owner_test" },
    title: "Regular Chat",
    lifecycle: "active",
    attention: "none",
    revision: 1,
    messageCount: 0,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("shared Chat route synchronization", () => {
  it("keeps entering, leaving, and browser history synchronized with the Chat view", async () => {
    window.history.replaceState(null, "", "/shared");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/events?")) return new Response(new ReadableStream());
      if (url.includes("/api/chats?")) return Response.json({ items: [record] });
      if (url.includes("/api/chats/chat_regular?")) {
        return Response.json({ record, messages: [], turns: [], runs: [], activities: [] });
      }
      throw new Error("UnexpectedRequest");
    }));

    const { result } = renderHook(() => useCanonicalChatState({
      initialCollaborationView: { kind: "home" },
    }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    act(() => result.current.openSharedChat!(scopeId));
    expect(window.location.pathname).toBe(`/shared/chat/${scopeId}`);
    expect(result.current.collaborationView).toEqual({ kind: "chat", scopeId });

    await act(async () => { await result.current.newChat(); });
    expect(window.location.pathname).toBe("/");
    expect(result.current.collaborationView).toBeUndefined();

    act(() => {
      window.history.pushState(null, "", `/shared/chat/${scopeId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.collaborationView).toEqual({ kind: "chat", scopeId });

    act(() => {
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.collaborationView).toBeUndefined();

    act(() => result.current.openSharedChat!(scopeId));
    act(() => result.current.switchConversation("chat_regular"));
    expect(window.location.pathname).toBe("/");
    expect(result.current.collaborationView).toBeUndefined();

    window.history.pushState(null, "", "/settings");
    act(() => result.current.switchConversation("chat_regular"));
    expect(window.location.pathname).toBe("/settings");
  });
});
