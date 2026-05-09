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
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/apps", {
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    });

    fetchMock.mockRestore();
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
});
