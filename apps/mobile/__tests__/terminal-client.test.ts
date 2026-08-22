import { GatewayClient } from "../lib/gateway-client";
import {
  MobileTerminalClient,
  MobileTerminalConnection,
  buildTerminalWebSocketUrl,
  isSafeSessionId,
  parseTerminalSessions,
} from "../lib/terminal-client";
import { jsonResponse } from "./mobile-shell-test-utils";

const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";
const SESSION_ID = `${WORKSPACE_ID}:${TAB_ID}`;
const TERMINAL_REF = { workspaceId: WORKSPACE_ID, tabId: TAB_ID };

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

  it("parses only safe terminal workspace/tab summaries", () => {
    expect(parseTerminalSessions([
      { id: WORKSPACE_ID, revision: 2, tabs: [{ id: TAB_ID, name: "Shell", cwd: "/home/matrix/home", status: "running", revision: 3 }] },
      { id: "../../../secret", tabs: [] },
      { tabs: [] },
    ])).toEqual([
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, tabId: TAB_ID, workspaceRevision: 2, revision: 3, name: "Shell", cwd: "/home/matrix/home", state: "running" },
    ]);
  });

  it("fetches shell sessions (by name) through the authenticated gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      workspaces: [{ id: WORKSPACE_ID, revision: 2, tabs: [{ id: TAB_ID, name: "Shell", cwd: "~", status: "running", revision: 3 }] }],
    }));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    await expect(gateway.getTerminalSessions()).resolves.toEqual([
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, tabId: TAB_ID, workspaceRevision: 2, revision: 3, name: "Shell", cwd: "~", state: "running" },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.test/api/terminal/workspaces",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer clerk-token" }),
      }),
    );
  });

  it("terminates tabs by TerminalRef and rejects unsafe refs locally", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({}, { status: 404 }));

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    await expect(gateway.deleteTerminalSession(SESSION_ID)).resolves.toBe(true);
    await expect(gateway.deleteTerminalSession("../bad")).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.test/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("creates a tab in the ensured main workspace", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/terminal/workspaces/ensure") && init?.method === "POST") return jsonResponse({ workspace: { id: WORKSPACE_ID } });
      if (String(input).endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) && init?.method === "POST") return jsonResponse({ tab: { id: TAB_ID } }, { status: 201 });
      return jsonResponse({});
    });

    const gateway = new GatewayClient("https://app.matrix-os.test", "clerk-token");
    const created = await gateway.createTerminalSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(created).toBe(SESSION_ID);
  });

  it("builds token-authenticated terminal websocket URLs", () => {
    expect(buildTerminalWebSocketUrl("https://app.matrix-os.test/", SESSION_ID, "ws token")).toBe(
      `wss://app.matrix-os.test/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=mobile&token=ws+token`,
    );
    expect(isSafeSessionId(SESSION_ID)).toBe(true);
    expect(isSafeSessionId("../bad")).toBe(false);
  });

  it("sends resize, input, and detach frames (no attach frame; name is in the query)", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const messages: unknown[] = [];
    const statuses: string[] = [];
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
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
      { type: "resize", terminalRef: TERMINAL_REF, mode: "soft", size: { cols: 220, rows: 70 } },
      { type: "input", terminalRef: TERMINAL_REF, data: "pwd\r" },
      { type: "resize", terminalRef: TERMINAL_REF, mode: "soft", size: { cols: 500, rows: 200 } },
      { type: "detach", terminalRef: TERMINAL_REF },
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
      sessionId: SESSION_ID,
      onMessage: jest.fn(),
    });

    expect(connection).toBeTruthy();
    expect(webSocketMock).toHaveBeenCalledWith(
      `wss://app.matrix-os.test/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=mobile&token=ws-token`,
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
      sessionId: SESSION_ID,
      onMessage: jest.fn(),
    });

    expect(connection).toBeTruthy();
    expect(webSocketMock).toHaveBeenCalledWith(
      `wss://app.matrix-os.test/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=mobile`,
      [],
      { headers: { Authorization: "Bearer clerk-token" } },
    );
  });

  it("closes sockets before open and uses local ready-state constants", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    (ws as unknown as MockWebSocket).readyState = 0;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      cwd: "projects",
      onMessage: jest.fn(),
    });

    connection.attach();
    connection.detach();

    expect((ws as unknown as MockWebSocket).closed).toBe(true);
    expect((ws as unknown as MockWebSocket).sent).toEqual([]);
  });
});
