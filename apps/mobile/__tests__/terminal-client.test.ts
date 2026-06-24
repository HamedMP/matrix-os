import { GatewayClient } from "../lib/gateway-client";
import {
  MobileTerminalClient,
  MobileTerminalConnection,
  buildTerminalWebSocketUrl,
  isSafeSessionId,
  parseTerminalSessions,
} from "../lib/terminal-client";
import { jsonResponse } from "./mobile-shell-test-utils";

const SESSION_ID = "c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  failSends = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string) {
    if (this.failSends) throw new Error("send failed");
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mobile terminal client", () => {
  const OriginalWebSocket = global.WebSocket;

  afterEach(() => {
    global.WebSocket = OriginalWebSocket;
    jest.restoreAllMocks();
  });

  it("parses only safe terminal session summaries", () => {
    expect(parseTerminalSessions([
      { sessionId: SESSION_ID, cwd: "/home/matrix/home", state: "running", attachedClients: 1 },
      { sessionId: "../../../secret", cwd: "/tmp", state: "running" },
      { cwd: "/tmp" },
    ])).toEqual([
      { sessionId: SESSION_ID, cwd: "/home/matrix/home", state: "running", attachedClients: 1 },
    ]);
  });

  it("fetches terminal sessions through the authenticated gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse([
      { sessionId: SESSION_ID, cwd: "/home/matrix/home/projects", state: "running" },
    ]));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    await expect(gateway.getTerminalSessions()).resolves.toEqual([
      { sessionId: SESSION_ID, cwd: "/home/matrix/home/projects", state: "running" },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.test/api/terminal/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer clerk-token" }),
      }),
    );
  });

  it("deletes terminal sessions idempotently and rejects unsafe IDs locally", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({}, { status: 404 }));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    await expect(gateway.deleteTerminalSession(SESSION_ID)).resolves.toBe(true);
    await expect(gateway.deleteTerminalSession("../bad")).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.test/api/terminal/sessions/${SESSION_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("builds token-authenticated terminal websocket URLs", () => {
    expect(buildTerminalWebSocketUrl("https://app.matrix-os.test/", "ws token")).toBe(
      "wss://app.matrix-os.test/ws/terminal?token=ws%20token",
    );
    expect(isSafeSessionId(SESSION_ID)).toBe(true);
    expect(isSafeSessionId("../bad")).toBe(false);
  });

  it("sends attach, resize, input, and detach frames over the terminal websocket", async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const messages: unknown[] = [];
    const statuses: string[] = [];
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      cwd: "projects",
      cols: 220,
      rows: 70,
      onMessage: (frame) => messages.push(frame),
      onStatus: (status) => statuses.push(status),
    });

    const attachPromise = connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    await expect(attachPromise).resolves.toBeUndefined();
    connection.sendInput("pwd\r");
    connection.resize(999, 999);
    (ws as unknown as MockWebSocket).onmessage?.({ data: JSON.stringify({ type: "output", data: "ok" }) });
    connection.detach();

    expect(statuses).toEqual(["connecting", "open", "closed"]);
    expect((ws as unknown as MockWebSocket).sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "attach", sessionId: SESSION_ID, cwd: "projects" },
      { type: "resize", cols: 220, rows: 70 },
      { type: "input", data: "pwd\r" },
      { type: "resize", cols: 500, rows: 200 },
      { type: "detach" },
    ]);
    expect(messages).toEqual([{ type: "output", data: "ok" }]);
    expect((ws as unknown as MockWebSocket).closed).toBe(true);
  });

  it("opens terminal sockets with browser-compatible query auth and native bearer headers", async () => {
    const webSocketMock = jest.fn().mockImplementation(() => new MockWebSocket());
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;
    jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ token: "ws-token" }));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    const terminalClient = new MobileTerminalClient(gateway);
    const connection = await terminalClient.connect({
      cwd: "projects",
      onMessage: jest.fn(),
    });

    expect(connection).toBeTruthy();
    expect(webSocketMock).toHaveBeenCalledWith(
      "wss://app.matrix-os.test/ws/terminal?token=ws-token",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );
  });

  it("keeps connect pending until socket open sends the attach frame", async () => {
    const socket = new MockWebSocket();
    socket.readyState = MockWebSocket.CONNECTING;
    const gateway = {
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
    };
    const terminalClient = new MobileTerminalClient(gateway as unknown as GatewayClient);
    const statuses: string[] = [];
    let settled = false;

    const connectPromise = terminalClient.connect({
      cwd: "projects",
      onMessage: jest.fn(),
      onStatus: (status) => statuses.push(status),
    }).then((connection) => {
      settled = true;
      return connection;
    });

    await flushPromises();

    expect(gateway.openTerminalWebSocket).toHaveBeenCalledWith("ws-token");
    expect(settled).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(statuses).toEqual(["connecting"]);

    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();

    await expect(connectPromise).resolves.toBeTruthy();
    expect(settled).toBe(true);
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "attach", cwd: "projects" },
    ]);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("does not send attach after a pending connection is closed before open", async () => {
    const socket = new MockWebSocket();
    socket.readyState = MockWebSocket.CONNECTING;
    const gateway = {
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
    };
    const terminalClient = new MobileTerminalClient(gateway as unknown as GatewayClient);
    const pendingConnections: MobileTerminalConnection[] = [];

    const connectPromise = terminalClient.connect({
      cwd: "projects",
      onMessage: jest.fn(),
      onConnection: (connection) => {
        pendingConnections.push(connection);
      },
    });

    await flushPromises();
    pendingConnections[0]?.close();
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();

    await expect(connectPromise).rejects.toThrow("Terminal connection closed before attach");
    expect(socket.closed).toBe(true);
    expect(socket.sent).toEqual([]);
  });

  it("rejects pending connects when a socket closes before attach is sent", async () => {
    const socket = new MockWebSocket();
    socket.readyState = MockWebSocket.CONNECTING;
    const gateway = {
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
    };
    const terminalClient = new MobileTerminalClient(gateway as unknown as GatewayClient);
    const statuses: string[] = [];

    const connectPromise = terminalClient.connect({
      cwd: "projects",
      onMessage: jest.fn(),
      onStatus: (status) => statuses.push(status),
    });

    await flushPromises();
    socket.close();

    await expect(connectPromise).rejects.toThrow("Terminal connection closed before attach");
    expect(socket.sent).toEqual([]);
    expect(statuses).toEqual(["connecting", "closed"]);
  });

  it("does not emit duplicate status transitions for pre-attach socket errors", async () => {
    const socket = new MockWebSocket();
    socket.readyState = MockWebSocket.CONNECTING;
    const gateway = {
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
    };
    const terminalClient = new MobileTerminalClient(gateway as unknown as GatewayClient);
    const statuses: string[] = [];

    const connectPromise = terminalClient.connect({
      cwd: "projects",
      onMessage: jest.fn(),
      onStatus: (status) => statuses.push(status),
    });

    await flushPromises();
    socket.onerror?.();
    socket.onclose?.();

    await expect(connectPromise).rejects.toThrow("Terminal connection failed before attach");
    expect(socket.sent).toEqual([]);
    expect(statuses).toEqual(["connecting"]);
  });

  it("rejects pending connects when attach cannot be sent after open", async () => {
    const socket = new MockWebSocket();
    socket.readyState = MockWebSocket.CONNECTING;
    socket.failSends = true;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const gateway = {
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
    };
    const terminalClient = new MobileTerminalClient(gateway as unknown as GatewayClient);
    const statuses: string[] = [];

    const connectPromise = terminalClient.connect({
      cwd: "projects",
      onMessage: jest.fn(),
      onStatus: (status) => statuses.push(status),
    });

    await flushPromises();
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();

    await expect(connectPromise).rejects.toThrow("Terminal connection opened before attach could be sent");
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
    expect(statuses).toEqual(["connecting"]);
    expect(warnSpy).toHaveBeenCalledWith("[mobile] terminal websocket send failed", "Error");
  });

  it("opens unauthenticated terminal sockets when the gateway returns no ws token", async () => {
    const webSocketMock = jest.fn().mockImplementation(() => new MockWebSocket());
    global.WebSocket = webSocketMock as unknown as typeof WebSocket;
    jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ token: null }));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    const terminalClient = new MobileTerminalClient(gateway);
    const connection = await terminalClient.connect({
      cwd: "projects",
      onMessage: jest.fn(),
    });

    expect(connection).toBeTruthy();
    expect(webSocketMock).toHaveBeenCalledWith(
      "wss://app.matrix-os.test/ws/terminal",
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );
  });

  it("closes sockets before open and uses local ready-state constants", async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    (ws as unknown as MockWebSocket).readyState = 0;
    const connection = new MobileTerminalConnection(ws, {
      cwd: "projects",
      onMessage: jest.fn(),
    });

    const attachPromise = connection.attach();
    connection.detach();

    await expect(attachPromise).rejects.toThrow("Terminal connection closed before attach");
    expect((ws as unknown as MockWebSocket).closed).toBe(true);
    expect((ws as unknown as MockWebSocket).sent).toEqual([]);
  });
});
