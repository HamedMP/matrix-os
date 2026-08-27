import { describe, expect, it, vi } from "vitest";
import { ClientApiError, createShellApiClient } from "@/api/http";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createShellApiClient", () => {
  it("resolves the gateway URL at request time and composes caller cancellation with its timeout", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { apps: [] }));
    const controller = new AbortController();
    let gatewayUrl = "https://first.test";
    const api = createShellApiClient({ getGatewayUrl: () => gatewayUrl, fetchFn });

    gatewayUrl = "https://second.test";
    await api.get("/api/apps", { signal: controller.signal });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://second.test/api/apps");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect((init as RequestInit).signal!.aborted).toBe(true);
  });

  it("maps unsafe gateway failures to generic client errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, { error: "/private/secret" }));
    const api = createShellApiClient({ getGatewayUrl: () => "https://gateway.test", fetchFn });

    await expect(api.get("/api/apps")).rejects.toEqual(
      expect.objectContaining<ClientApiError>({ category: "server", detail: undefined }),
    );
  });
});
