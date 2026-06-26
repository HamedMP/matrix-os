import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shell/src/lib/gateway.js", () => ({
  getGatewayUrl: () => "http://gateway.test",
  getGatewayWs: () => "ws://gateway.test/ws",
}));

function tokenResponse(token: string | null, expiresAt = Date.now() + 60_000) {
  return new Response(JSON.stringify({ token, expiresAt }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("websocket auth", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires a fresh token for shell live socket URLs when requested", async () => {
    vi.mocked(fetch).mockResolvedValue(tokenResponse(null));
    const { buildAuthenticatedWebSocketUrl } = await import("../../shell/src/lib/websocket-auth.js");

    await expect(buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true }))
      .rejects
      .toMatchObject({ name: "WebSocketCredentialUnavailableError" });
  });

  it("refreshes before token expiry instead of reusing an expiring credential", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokenResponse("first", Date.now() + 20_000))
      .mockResolvedValueOnce(tokenResponse("second", Date.now() + 60_000));
    const { buildAuthenticatedWebSocketUrl } = await import("../../shell/src/lib/websocket-auth.js");

    await expect(buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true }))
      .resolves
      .toContain("token=first");
    await expect(buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true }))
      .resolves
      .toContain("token=second");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
