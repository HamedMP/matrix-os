import { describe, expect, it, vi } from "vitest";
import { createShellClient } from "../../packages/sync-client/src/cli/shell-client.js";

describe("shell REST client", () => {
  it("lists sessions with bearer auth, JSON parsing, and fetch timeout", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sessions: [] })));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.listSessions()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://gateway/api/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns stable generic errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "session_not_found", message: "/home/alice" } }),
      { status: 404 },
    ));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.deleteSession("missing")).rejects.toMatchObject({
      code: "session_not_found",
      message: "Request failed",
    });
  });

  it("builds authenticated terminal websocket URLs for attach", () => {
    const client = createShellClient({
      gatewayUrl: "https://gateway.example",
      token: "tok",
    });

    expect(client.createAttachUrl("main", { fromSeq: 7 })).toBe(
      "wss://gateway.example/ws/terminal?session=main&fromSeq=7",
    );
  });
});
