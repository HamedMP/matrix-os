import { describe, expect, it, vi } from "vitest";
import { createTuiGatewayClient, TuiGatewayClientError } from "../../src/cli/tui/gateway-client.js";

describe("TUI gateway client", () => {
  it("sends bearer auth and an AbortSignal.timeout signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = createTuiGatewayClient({
      gatewayUrl: "https://gateway.example",
      token: "token-1",
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1234,
    });

    await expect(client.requestJson("/api/status")).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example/api/status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("normalizes failed responses into safe errors", async () => {
    const client = createTuiGatewayClient({
      gatewayUrl: "https://gateway.example",
      fetch: (async () => new Response(
        JSON.stringify({ error: { code: "postgres://secret", message: "/Users/private" } }),
        { status: 500 },
      )) as typeof fetch,
    });

    await expect(client.requestJson("/api/status")).rejects.toMatchObject({
      code: "request_failed",
      message: "Request failed",
    } satisfies Partial<TuiGatewayClientError>);
  });

  it("rejects malformed successful JSON with a safe invalid-response error", async () => {
    const client = createTuiGatewayClient({
      gatewayUrl: "https://gateway.example",
      fetch: (async () => new Response("", { status: 200 })) as typeof fetch,
    });

    await expect(client.requestJson("/api/status")).rejects.toMatchObject({
      code: "invalid_response",
      message: "Request failed",
    } satisfies Partial<TuiGatewayClientError>);
  });

});
