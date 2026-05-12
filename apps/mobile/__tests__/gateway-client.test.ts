import { GatewayClient } from "../lib/gateway-client";

describe("GatewayClient", () => {
  it("initializes with disconnected state", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.connectionState).toBe("disconnected");
  });

  it("derives HTTP URL correctly", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.httpUrl).toBe("http://localhost:4000");
  });

  it("derives WS URL correctly", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.wsUrl).toBe("ws://localhost:4000/ws");
  });

  it("converts https to wss", () => {
    const client = new GatewayClient("https://my.gateway.com");
    expect(client.wsUrl).toBe("wss://my.gateway.com/ws");
  });

  it("strips trailing slashes from base URL", () => {
    const client = new GatewayClient("http://localhost:4000///");
    expect(client.httpUrl).toBe("http://localhost:4000");
  });

  it("registers message handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onMessage(handler);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("registers state change handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onStateChange(handler);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("unsubscribes message handlers", () => {
    const client = new GatewayClient("http://localhost:4000");
    const handler = jest.fn();
    const unsub = client.onMessage(handler);
    unsub();
    // handler should no longer be registered
  });

  it("reports isConnected as false when not connected", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.isConnected).toBe(false);
  });

  it("sendMessage returns false when not connected", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.sendMessage("hello")).toBe(false);
  });

  it("send returns false when not connected", () => {
    const client = new GatewayClient("http://localhost:4000");
    expect(client.send({ type: "message", text: "test" })).toBe(false);
  });

  it("opens native websocket connections with bearer headers", () => {
    const OriginalWebSocket = global.WebSocket;
    const webSocketMock = jest.fn().mockImplementation(() => ({
      readyState: 0,
      close: jest.fn(),
    }));
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");
    client.connect();

    expect(webSocketMock).toHaveBeenCalledWith(
      "wss://app.matrix-os.com/ws",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );

    global.WebSocket = OriginalWebSocket;
  });

  it("uses platform websocket tokens in the upgrade URL when present", () => {
    const OriginalWebSocket = global.WebSocket;
    const webSocketMock = jest.fn().mockImplementation(() => ({
      readyState: 0,
      close: jest.fn(),
    }));
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token", "ws-token");
    client.connect();

    expect(webSocketMock).toHaveBeenCalledWith(
      "wss://app.matrix-os.com/ws?token=ws-token",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );

    global.WebSocket = OriginalWebSocket;
  });

  it("fetches installed apps from the gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce([
        {
          name: "Notes",
          file: "notes/index.html",
          path: "/files/apps/notes/index.html",
        },
      ]),
    } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.getApps()).resolves.toEqual([
      {
        name: "Notes",
        file: "notes/index.html",
        path: "/files/apps/notes/index.html",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/apps",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
      }),
    );

    fetchMock.mockRestore();
  });

  it("refreshes Clerk bearer tokens for each gateway HTTP request", async () => {
    const getToken = jest
      .fn<Promise<string | null>, []>()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce([]),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          manifest: { name: "Notes" },
          runtimeState: { status: "ready" },
        }),
      } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000", getToken);
    await expect(client.getApps()).resolves.toEqual([]);
    await expect(client.getAppManifest("notes")).resolves.toEqual({
      manifest: { name: "Notes" },
      runtimeState: { status: "ready" },
    });

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:4000/api/apps", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:4000/api/apps/notes/manifest", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token-2" }),
    }));

    fetchMock.mockRestore();
  });

  it("refreshes Clerk bearer tokens before building WebView headers", async () => {
    const getToken = jest.fn<Promise<string | null>, []>().mockResolvedValueOnce("fresh-token");

    const client = new GatewayClient("http://localhost:4000", getToken);
    await expect(client.webViewHeaders()).resolves.toEqual({
      Authorization: "Bearer fresh-token",
    });

    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("fetches per-app manifest details from the gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        manifest: { name: "Notes" },
        runtimeState: { status: "ready" },
      }),
    } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.getAppManifest("notes")).resolves.toEqual({
      manifest: { name: "Notes" },
      runtimeState: { status: "ready" },
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/apps/notes/manifest", {
      headers: {
        "Content-Type": "application/json",
      },
    });

    fetchMock.mockRestore();
  });

  it("preserves path separators when fetching nested app manifests", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        manifest: { name: "Chess" },
        runtimeState: { status: "ready" },
      }),
    } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000");
    await expect(client.getAppManifest("games/chess")).resolves.toEqual({
      manifest: { name: "Chess" },
      runtimeState: { status: "ready" },
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/apps/games/chess/manifest", {
      headers: {
        "Content-Type": "application/json",
      },
    });

    fetchMock.mockRestore();
  });

  it("preserves path separators when creating nested app session tokens", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        launchUrl: "/apps/chess/?session=token",
        expiresAt: 1_779_000_000_000,
      }),
    } as unknown as Response);

    const client = new GatewayClient("http://localhost:4000", "token");
    await expect(client.createAppSessionToken("games/chess")).resolves.toEqual({
      launchUrl: "/apps/chess/?session=token",
      expiresAt: 1_779_000_000_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/apps/games/chess/session-token",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );

    fetchMock.mockRestore();
  });

  it("fetches a platform websocket token using bearer auth", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({ token: "ws-token" }),
    } as unknown as Response);

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");
    await expect(client.getWsToken()).resolves.toBe("ws-token");
    expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/api/auth/ws-token", {
      headers: {
        Authorization: "Bearer clerk-token",
        "Content-Type": "application/json",
      },
    });

    fetchMock.mockRestore();
  });

  it("refreshes expired websocket tokens before reconnecting", async () => {
    jest.useFakeTimers();
    const OriginalWebSocket = global.WebSocket;
    const sockets: Array<{
      readyState: number;
      close: jest.Mock;
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onclose: ((event: { code: number; reason: string }) => void) | null;
    }> = [];
    const webSocketMock = jest.fn().mockImplementation(() => {
      const socket = {
        readyState: 0,
        close: jest.fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      sockets.push(socket);
      return socket;
    });
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        token: "fresh-ws-token",
        expiresAt: Date.now() + 300_000,
      }),
    } as unknown as Response);

    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");
    client.setWebSocketToken("expired-ws-token", Date.now() - 1000);
    client.connect();
    sockets[0]?.onclose?.({ code: 1006, reason: "" });

    await jest.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/api/auth/ws-token", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer clerk-token" }),
    }));
    expect(webSocketMock).toHaveBeenLastCalledWith(
      "wss://app.matrix-os.com/ws?token=fresh-ws-token",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );

    fetchMock.mockRestore();
    global.WebSocket = OriginalWebSocket;
    jest.useRealTimers();
  });
});
