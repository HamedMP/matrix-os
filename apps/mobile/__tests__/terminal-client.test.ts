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
const SHELL_NAME = "matrix-7af3c2e";
const TWO_WORD_SESSION_NAME_PATTERN = /^[a-z]+-[a-z]+$/;

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

  it("fetches shell sessions (by name) through the authenticated gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      sessions: [{ name: SHELL_NAME, visualStatus: "running", attachedClients: 1 }],
    }));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    await expect(gateway.getTerminalSessions()).resolves.toEqual([
      { sessionId: SHELL_NAME, cwd: "~", state: "running", visualStatus: "running", attachedClients: 1 },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.test/api/terminal/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer clerk-token" }),
      }),
    );
  });

  it("deletes shell sessions by name (force) and rejects unsafe names locally", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({}, { status: 404 }));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    await expect(gateway.deleteTerminalSession(SHELL_NAME)).resolves.toBe(true);
    await expect(gateway.deleteTerminalSession("../bad")).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.test/api/terminal/sessions/${SHELL_NAME}?force=1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("creates shell sessions with two-word names for every collision retry", async () => {
    const postedNames: string[] = [];
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/terminal/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string };
        if (typeof body.name === "string") postedNames.push(body.name);
        if (postedNames.length <= 3) {
          return jsonResponse({ error: { code: "session_exists", message: "Request failed" } }, { status: 409 });
        }
        return jsonResponse({ name: body.name }, { status: 201 });
      }
      return jsonResponse({});
    });

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    const created = await gateway.createTerminalSession();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(created).toBe(postedNames[3]);
    expect(postedNames.slice(0, 3)).toEqual([
      expect.stringMatching(TWO_WORD_SESSION_NAME_PATTERN),
      expect.stringMatching(TWO_WORD_SESSION_NAME_PATTERN),
      expect.stringMatching(TWO_WORD_SESSION_NAME_PATTERN),
    ]);
    expect(postedNames[3]).toMatch(TWO_WORD_SESSION_NAME_PATTERN);
    expect(postedNames.every((name) => name.split("-").length === 2)).toBe(true);
  });

  it("builds token-authenticated terminal websocket URLs", () => {
    expect(buildTerminalWebSocketUrl("https://app.matrix-os.test/", "ws token")).toBe(
      "wss://app.matrix-os.test/ws/terminal?token=ws%20token",
    );
    expect(isSafeSessionId(SESSION_ID)).toBe(true);
    expect(isSafeSessionId("../bad")).toBe(false);
  });

  it("sends resize, input, and detach frames (no attach frame; name is in the query)", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const messages: unknown[] = [];
    const statuses: string[] = [];
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SHELL_NAME,
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
      sessionId: SHELL_NAME,
      onMessage: jest.fn(),
    });

    expect(connection).toBeTruthy();
    expect(webSocketMock).toHaveBeenCalledWith(
      `wss://app.matrix-os.test/ws/terminal/session?session=${SHELL_NAME}&token=ws-token`,
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
      sessionId: SHELL_NAME,
      onMessage: jest.fn(),
    });

    expect(connection).toBeTruthy();
    expect(webSocketMock).toHaveBeenCalledWith(
      `wss://app.matrix-os.test/ws/terminal/session?session=${SHELL_NAME}`,
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
});
