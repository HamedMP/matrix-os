import { GatewayClient } from "../lib/gateway-client";
import {
  MOBILE_TERMINAL_KEEPALIVE_MS,
  MobileTerminalClient,
  MobileTerminalConnection,
  buildTerminalWebSocketUrl,
  isSafeSessionId,
  parseTerminalSessions,
} from "../lib/terminal-client";
import { jsonResponse } from "./mobile-shell-test-utils";

const SESSION_ID = "c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9";

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

describe("mobile terminal client", () => {
  const OriginalWebSocket = global.WebSocket;

  afterEach(() => {
    global.WebSocket = OriginalWebSocket;
    jest.useRealTimers();
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

  it("sends attach, resize, input, and detach frames over the terminal websocket", () => {
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

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    connection.sendInput("pwd\r");
    connection.resize(999, 999);
    (ws as unknown as MockWebSocket).onmessage?.({ data: JSON.stringify({ type: "output", data: "ok" }) });
    connection.detach();

    expect(statuses).toEqual(["connecting", "open"]);
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

  it("closes sockets before open and uses local ready-state constants", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    (ws as unknown as MockWebSocket).readyState = 0;
    const connection = new MobileTerminalConnection(ws, {
      cwd: "projects",
      onMessage: jest.fn(),
    });

    connection.attach();
    connection.detach();

    expect((ws as unknown as MockWebSocket).closed).toBe(true);
    expect((ws as unknown as MockWebSocket).sent).toEqual([]);
  });

  it("sends periodic terminal pings while attached", () => {
    jest.useFakeTimers();
    expect(MOBILE_TERMINAL_KEEPALIVE_MS).toBeLessThan(120_000);

    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      cwd: "projects",
      onMessage: jest.fn(),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS - 1);
    expect(parseSentFrames(ws)).toEqual([{ type: "attach", cwd: "projects" }]);

    jest.advanceTimersByTime(1);
    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS);

    expect(parseSentFrames(ws)).toEqual([
      { type: "attach", cwd: "projects" },
      { type: "ping" },
      { type: "ping" },
    ]);
  });

  it("stops terminal keepalive pings after detach", () => {
    jest.useFakeTimers();
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      cwd: "projects",
      onMessage: jest.fn(),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS);
    connection.detach();
    const sentAfterDetach = parseSentFrames(ws);

    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS * 2);

    expect(sentAfterDetach).toEqual([
      { type: "attach", cwd: "projects" },
      { type: "ping" },
      { type: "detach" },
    ]);
    expect(parseSentFrames(ws)).toEqual(sentAfterDetach);
  });

  it("stops terminal keepalive pings after destroy", () => {
    jest.useFakeTimers();
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      cwd: "projects",
      onMessage: jest.fn(),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS);
    connection.destroy();
    const sentAfterDestroy = parseSentFrames(ws);

    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS * 2);

    expect(sentAfterDestroy).toEqual([
      { type: "attach", cwd: "projects" },
      { type: "ping" },
      { type: "destroy" },
    ]);
    expect(parseSentFrames(ws)).toEqual(sentAfterDestroy);
  });

  it("stops terminal keepalive pings after socket close", () => {
    jest.useFakeTimers();
    const statuses: string[] = [];
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      cwd: "projects",
      onMessage: jest.fn(),
      onStatus: (status) => statuses.push(status),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS);
    (ws as unknown as MockWebSocket).onclose?.();
    const sentAfterClose = parseSentFrames(ws);

    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS * 2);

    expect(statuses).toEqual(["connecting", "open", "closed"]);
    expect(sentAfterClose).toEqual([
      { type: "attach", cwd: "projects" },
      { type: "ping" },
    ]);
    expect(parseSentFrames(ws)).toEqual(sentAfterClose);
  });

  it("does not attach or start terminal keepalive pings after pre-open close", () => {
    jest.useFakeTimers();
    const statuses: string[] = [];
    const ws = new MockWebSocket() as unknown as WebSocket;
    (ws as unknown as MockWebSocket).readyState = 0;
    const connection = new MobileTerminalConnection(ws, {
      cwd: "projects",
      onMessage: jest.fn(),
      onStatus: (status) => statuses.push(status),
    });

    connection.attach();
    connection.close();
    (ws as unknown as MockWebSocket).readyState = MockWebSocket.OPEN;
    (ws as unknown as MockWebSocket).onopen?.();
    jest.advanceTimersByTime(MOBILE_TERMINAL_KEEPALIVE_MS * 2);

    expect(statuses).toEqual(["connecting"]);
    expect((ws as unknown as MockWebSocket).closed).toBe(true);
    expect(parseSentFrames(ws)).toEqual([]);
  });
});

function parseSentFrames(ws: WebSocket): unknown[] {
  return (ws as unknown as MockWebSocket).sent.map((frame) => JSON.parse(frame));
}
