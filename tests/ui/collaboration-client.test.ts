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
});
