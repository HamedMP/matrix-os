import { describe, expect, it, vi } from "vitest";
import { createCollaborationBrowserApi } from "../../packages/ui/src/collaboration/client.js";

describe("collaboration browser client", () => {
  it("uses exact bounded requests and caller-provided actor authentication", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "content-length": "11" },
    }));
    const api = createCollaborationBrowserApi({
      baseUrl: "https://app.matrix-os.com",
      fetchImpl,
      getHeaders: async () => ({ Authorization: "Bearer actor-token" }),
    });
    await expect(api.post("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/messages", { text: "hello" }))
      .resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://app.matrix-os.com/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/messages");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer actor-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(api.get("/api/private/files")).rejects.toThrow("CollaborationUnavailable");
  });

  it("rejects oversized responses before parsing them", async () => {
    const api = createCollaborationBrowserApi({
      baseUrl: "https://app.matrix-os.com",
      fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    });
    await expect(api.get("/api/collaboration/shared")).rejects.toThrow("CollaborationUnavailable");
  });

  it("sends DELETE conditions as allowlisted headers without a request body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "revoked" }), {
      headers: { "content-type": "application/json" },
    }));
    const api = createCollaborationBrowserApi({ baseUrl: "https://app.matrix-os.com", fetchImpl });
    await api.delete(
      "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/members/user_editor",
      {
        clientRequestId: "40000000-0000-4000-8000-000000000001",
        expectedRevision: "3",
        expectedMemberRevision: "2",
      },
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("x-matrix-client-request-id"))
      .toBe("40000000-0000-4000-8000-000000000001");
  });

  it("does not advance the realtime cursor when canonical refresh fails", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const sockets: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onclose: (() => void) | null;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    let rejectRefresh!: (error: Error) => void;
    const refresh = new Promise<void>((_resolve, reject) => { rejectRefresh = reject; });
    const api = createCollaborationBrowserApi({
      baseUrl: "https://app.matrix-os.com",
      fetchImpl: async () => new Response(JSON.stringify({
        ticket: "t".repeat(43), expiresAt: "2026-09-07T12:00:30.000Z",
      }), { headers: { "content-type": "application/json" } }),
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = {
          onopen: null, onmessage: null, onerror: null, onclose: null,
          send: vi.fn(), close: vi.fn(),
        };
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const unsubscribe = api.subscribe!(
      "10000000-0000-4000-8000-000000000001",
      async () => refresh,
      vi.fn(),
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onmessage?.({ data: JSON.stringify({
      version: 1,
      type: "refresh_required",
      scopeId: "10000000-0000-4000-8000-000000000001",
      resourceId: "chat_one",
      authorityGeneration: "1",
      sequence: "103",
    }) });
    sockets[0]!.onmessage?.({ data: JSON.stringify({
      version: 1,
      type: "heartbeat",
      scopeId: "10000000-0000-4000-8000-000000000001",
      resourceId: "chat_one",
      authorityGeneration: "1",
      sequence: "104",
    }) });
    sockets[0]!.onmessage?.({ data: JSON.stringify({
      version: 1,
      type: "ready",
      scopeId: "10000000-0000-4000-8000-000000000001",
      resourceId: "chat_one",
      authorityGeneration: "1",
      sequence: "105",
    }) });
    rejectRefresh(new Error("refresh failed"));
    await vi.waitFor(() => expect(sockets[0]!.close).toHaveBeenCalled());
    sockets[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(new URL(urls[1]!).searchParams.get("after")).toBe("0");
    unsubscribe();
    vi.useRealTimers();
  });
});
