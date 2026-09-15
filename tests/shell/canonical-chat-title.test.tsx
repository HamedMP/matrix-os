// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => vi.unstubAllGlobals());
it("sends a concise title when Web Chat creates a conversation", async () => {
  let created: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/chats?") && init?.method !== "POST") return Response.json({ items: [] });
    if (String(url).endsWith("/api/chats") && init?.method === "POST") {
      created = JSON.parse(String(init.body));
      // Stop after recording creation; no provider or persistence is needed here.
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    return Response.json({}, { status: 404 });
  }));
  const { result, unmount } = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(result.current.conversations).toEqual([]));
  act(() => result.current.submitMessage("我想设计一个个人主页。请先用 request_user_input 工具询问我喜欢的视觉风格。", undefined, {
    instanceId: "codex_default", model: "test", interactionMode: "default", permissionMode: "supervised",
  }));
  await waitFor(() => expect(created?.title).toBe("我想设计一个个人主页"));
  unmount();
});
