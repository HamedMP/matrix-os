import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  http: "http://gateway.test",
  ws: "ws://gateway.test/ws",
}));

vi.mock("../../shell/src/lib/gateway.js", () => ({
  getGatewayUrl: () => gateway.http,
  getGatewayWs: () => gateway.ws,
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
    gateway.http = "http://gateway.test";
    gateway.ws = "ws://gateway.test/ws";
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

  it("preserves the explicit VM prefix for shell and terminal websocket paths", async () => {
    gateway.http = "https://app.matrix-os.com/vm/pr-1018";
    gateway.ws = "wss://app.matrix-os.com/vm/pr-1018/ws";
    vi.mocked(fetch).mockResolvedValue(tokenResponse("preview-token"));
    const { buildAuthenticatedWebSocketUrl } = await import("../../shell/src/lib/websocket-auth.js");

    await expect(buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true }))
      .resolves
      .toBe("wss://app.matrix-os.com/vm/pr-1018/ws?token=preview-token");
    await expect(buildAuthenticatedWebSocketUrl("/ws/terminal/session", { session: "main" }, { requireToken: true }))
      .resolves
      .toBe("wss://app.matrix-os.com/vm/pr-1018/ws/terminal/session?session=main&token=preview-token");
  });

  it("does not reuse a websocket token after the explicit computer route changes", async () => {
    gateway.http = "https://app.matrix-os.com/vm/main-computer";
    gateway.ws = "wss://app.matrix-os.com/vm/main-computer/ws";
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokenResponse("main-token"))
      .mockResolvedValueOnce(tokenResponse("preview-token"));
    const { buildAuthenticatedWebSocketUrl } = await import("../../shell/src/lib/websocket-auth.js");

    await expect(buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true }))
      .resolves
      .toContain("token=main-token");

    gateway.http = "https://app.matrix-os.com/vm/pr-1018";
    gateway.ws = "wss://app.matrix-os.com/vm/pr-1018/ws";

    await expect(buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true }))
      .resolves
      .toBe("wss://app.matrix-os.com/vm/pr-1018/ws?token=preview-token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
