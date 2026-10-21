import { GatewayClient } from "../lib/gateway-client";
import {
  MobileTerminalClient,
  MobileTerminalConnection,
  buildTerminalWebSocketUrl,
  isSafeSessionId,
  parseTerminalSessions,
} from "../lib/terminal-client";
import { jsonResponse } from "./mobile-shell-test-utils";

// The terminal client does not exercise Markdown rendering. Keep this focused
// React Native Jest suite from loading the ESM-only micromark implementation
// re-exported by the shared contracts package.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

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

  it("fetches shared workspace tabs through the authenticated gateway", async () => {
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
      `wss://app.matrix-os.test/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=mobile&inputCapability=binary-input-v1&lease=exclusive&token=ws+token`,
    );
    expect(isSafeSessionId(SESSION_ID)).toBe(true);
    expect(isSafeSessionId("../bad")).toBe(false);
  });

  function attachedFrame(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      type: "attached",
      terminalRef: TERMINAL_REF,
      canonicalSize: { cols: 120, rows: 36 },
      revision: 1,
      nextSeq: 0,
      ownership: "writer",
      leaseEpoch: 1,
      ...overrides,
    });
  }

  function sentFrames(ws: WebSocket) {
    return (ws as unknown as MockWebSocket).sent.map((frame) => JSON.parse(frame));
  }

  it("sends input and detach frames with the canonical TerminalRef", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const messages: unknown[] = [];
    const statuses: string[] = [];
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      onMessage: (frame) => messages.push(frame),
      onStatus: (status) => statuses.push(status),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    connection.sendInput("pwd\r");
    (ws as unknown as MockWebSocket).onmessage?.({ data: JSON.stringify({ type: "output", data: "ok" }) });
    connection.detach();

    expect(statuses).toEqual(["connecting", "open"]);
    expect(sentFrames(ws)).toEqual([
      { type: "input", terminalRef: TERMINAL_REF, data: "pwd\r" },
      { type: "detach", terminalRef: TERMINAL_REF },
    ]);
    expect(messages).toEqual([{ type: "output", data: "ok" }]);
    expect((ws as unknown as MockWebSocket).closed).toBe(true);
  });

  it("sizes the shared grid to the phone once it holds the write lease", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      cols: 49,
      rows: 36,
      onMessage: jest.fn(),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    // Nothing is declared before the computer has said who owns the terminal.
    expect(sentFrames(ws)).toEqual([]);

    (ws as unknown as MockWebSocket).onmessage?.({ data: attachedFrame() });

    expect(sentFrames(ws)).toEqual([
      { type: "resize", terminalRef: TERMINAL_REF, mode: "hard", size: { cols: 49, rows: 36 } },
    ]);
    connection.close();
  });

  it("declares a changed viewport once and keeps it inside the grid limits", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      cols: 49,
      rows: 36,
      onMessage: jest.fn(),
    });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({ data: attachedFrame() });

    expect(connection.resize(49, 36)).toBe(false);
    expect(connection.resize(49, 18)).toBe(true);
    expect(connection.resize(49, 18)).toBe(false);
    expect(connection.resize(999, 1)).toBe(true);

    expect(sentFrames(ws).map((frame) => frame.size)).toEqual([
      { cols: 49, rows: 36 },
      { cols: 49, rows: 18 },
      { cols: 500, rows: 5 },
    ]);
    connection.close();
  });

  it("declares the viewport measured while the socket was still attaching", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      onMessage: jest.fn(),
    });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();

    expect(connection.resize(49, 36)).toBe(false);
    (ws as unknown as MockWebSocket).onmessage?.({ data: attachedFrame() });

    expect(sentFrames(ws)).toEqual([
      { type: "resize", terminalRef: TERMINAL_REF, mode: "hard", size: { cols: 49, rows: 36 } },
    ]);
    connection.close();
  });

  it("never resizes a grid it is only following", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      cols: 49,
      rows: 36,
      onMessage: jest.fn(),
    });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({ data: attachedFrame({ ownership: "observer", leaseEpoch: undefined }) });

    expect(connection.resize(49, 18)).toBe(false);
    expect(sentFrames(ws)).toEqual([]);
    connection.close();
  });

  it("stops resizing the grid after another device takes the lease", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      cols: 49,
      rows: 36,
      onMessage: jest.fn(),
    });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({ data: attachedFrame() });
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({ type: "lease-revoked", terminalRef: TERMINAL_REF, epoch: 1 }),
    });

    expect(connection.resize(49, 18)).toBe(false);
    expect(sentFrames(ws)).toHaveLength(1);
    connection.close();
  });

  it("passes the shared grid size on to the screen", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const onMessage = jest.fn();
    const connection = new MobileTerminalConnection(ws, { sessionId: SESSION_ID, onMessage });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({
        type: "canonical-size",
        terminalRef: TERMINAL_REF,
        revision: 9,
        canonicalSize: { cols: 49, rows: 36 },
      }),
    });
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        terminalRef: TERMINAL_REF,
        revision: 9,
        seq: 4,
        ansi: "ready",
        canonicalSize: { cols: 49, rows: 36 },
      }),
    });

    expect(onMessage).toHaveBeenNthCalledWith(1, {
      type: "canonical-size",
      canonicalSize: { cols: 49, rows: 36 },
    });
    expect(onMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "snapshot",
      ansi: "ready",
      canonicalSize: { cols: 49, rows: 36 },
    }));
    connection.close();
  });

  it("drops frames whose grid size the emulator could not apply", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const onMessage = jest.fn();
    const connection = new MobileTerminalConnection(ws, { sessionId: SESSION_ID, cols: 49, rows: 36, onMessage });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    for (const canonicalSize of [undefined, { cols: 0, rows: 36 }, { cols: 49.5, rows: 36 }, { cols: 49, rows: 9_000 }, "49x36"]) {
      (ws as unknown as MockWebSocket).onmessage?.({ data: attachedFrame({ canonicalSize }) });
      (ws as unknown as MockWebSocket).onmessage?.({
        data: JSON.stringify({ type: "canonical-size", terminalRef: TERMINAL_REF, revision: 9, canonicalSize }),
      });
    }

    expect(onMessage).not.toHaveBeenCalled();
    expect(sentFrames(ws)).toEqual([]);
    connection.close();
  });

  it("keeps a snapshot whose grid size is unusable but leaves the size out", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const onMessage = jest.fn();
    const connection = new MobileTerminalConnection(ws, { sessionId: SESSION_ID, onMessage });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({ type: "snapshot", seq: 1, ansi: "ready", canonicalSize: { cols: -1, rows: 36 } }),
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).not.toHaveProperty("canonicalSize");
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ type: "snapshot", ansi: "ready" });
    connection.close();
  });

  it("reattaches after the socket drops unexpectedly", async () => {
    jest.useFakeTimers();
    const ws = new MockWebSocket() as unknown as WebSocket;
    const next = new MockWebSocket() as unknown as WebSocket;
    const reconnect = jest.fn().mockResolvedValue(next);
    const connection = new MobileTerminalConnection(ws, { sessionId: SESSION_ID, onMessage: jest.fn() }, reconnect);
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();

    (ws as unknown as MockWebSocket).onclose?.();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(reconnect).toHaveBeenCalledTimes(1);
    connection.close();
    jest.useRealTimers();
  });

  it("does not reattach to a terminal that has exited", async () => {
    jest.useFakeTimers();
    const ws = new MockWebSocket() as unknown as WebSocket;
    const reconnect = jest.fn();
    const statuses: string[] = [];
    const onMessage = jest.fn();
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      onMessage,
      onStatus: (status) => statuses.push(status),
    }, reconnect);
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({ data: attachedFrame() });

    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({ type: "exit", terminalRef: TERMINAL_REF, revision: 2, exitCode: 0 }),
    });
    (ws as unknown as MockWebSocket).onclose?.();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "exit" }));
    expect(reconnect).not.toHaveBeenCalled();
    expect((ws as unknown as MockWebSocket).closed).toBe(true);
    // The screen keeps the ended state it was just told about.
    expect(statuses).toEqual(["connecting", "open"]);
    jest.useRealTimers();
  });

  it("preserves binary emulator replies when the runtime advertises byte input", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      onMessage: jest.fn(),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({
        type: "attached",
        terminalRef: TERMINAL_REF,
        canonicalSize: { cols: 80, rows: 24 },
        revision: 1,
        nextSeq: 0,
        capabilities: ["binary-input-v1"],
      }),
    });

    expect(connection.sendBinary("\x1b]10;?\x07\x80\xff")).toBe(true);
    expect(JSON.parse((ws as unknown as MockWebSocket).sent.at(-1)!)).toEqual({
      type: "binary",
      terminalRef: TERMINAL_REF,
      dataBase64: "G10xMDs/B4D/",
    });
    connection.close();
  });

  it("keeps following output but blocks input after another device takes ownership", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const onMessage = jest.fn();
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      onMessage,
    });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({
        type: "attached",
        terminalRef: TERMINAL_REF,
        canonicalSize: { cols: 80, rows: 24 },
        revision: 1,
        nextSeq: 0,
        ownership: "writer",
        leaseEpoch: 1,
      }),
    });
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({ type: "lease-revoked", terminalRef: TERMINAL_REF, epoch: 1 }),
    });
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({ type: "output", terminalRef: TERMINAL_REF, revision: 1, seq: 1, data: "follow" }),
    });

    expect(connection.sendInput("blocked")).toBe(false);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "lease-revoked" }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "output", data: "follow" }));
    expect((ws as unknown as MockWebSocket).closed).toBe(false);
    connection.close();
  });

  it("uses text input for emulator replies when connected to an older runtime", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      onMessage: jest.fn(),
    });

    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({
        type: "attached",
        terminalRef: TERMINAL_REF,
        canonicalSize: { cols: 80, rows: 24 },
        revision: 1,
        nextSeq: 0,
      }),
    });

    expect(connection.sendBinary("\x1b]10;rgb:1111/2222/3333\x07")).toBe(true);
    expect(JSON.parse((ws as unknown as MockWebSocket).sent.at(-1)!)).toEqual({
      type: "input",
      terminalRef: TERMINAL_REF,
      data: "\x1b]10;rgb:1111/2222/3333\x07",
    });
    connection.close();
  });

  it("validates a complete binary reply before sending bounded chunks", () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = new MobileTerminalConnection(ws, {
      sessionId: SESSION_ID,
      onMessage: jest.fn(),
    });
    connection.attach();
    (ws as unknown as MockWebSocket).onopen?.();
    (ws as unknown as MockWebSocket).onmessage?.({
      data: JSON.stringify({
        type: "attached",
        terminalRef: TERMINAL_REF,
        canonicalSize: { cols: 80, rows: 24 },
        revision: 1,
        nextSeq: 0,
        capabilities: ["binary-input-v1"],
      }),
    });
    const before = (ws as unknown as MockWebSocket).sent.length;

    expect(connection.sendBinary(`${"x".repeat(32_768)}\u{100}`)).toBe(false);
    expect((ws as unknown as MockWebSocket).sent).toHaveLength(before);

    expect(connection.sendBinary("x".repeat(70_000))).toBe(true);
    const chunks = (ws as unknown as MockWebSocket).sent
      .slice(before)
      .map((value) => JSON.parse(value) as { type: string; dataBase64: string });
    expect(chunks.map((frame) => atob(frame.dataBase64).length)).toEqual([32_768, 32_768, 4_464]);
    connection.close();
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
      `wss://app.matrix-os.test/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=mobile&inputCapability=binary-input-v1&lease=exclusive&token=ws-token`,
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
      `wss://app.matrix-os.test/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=mobile&inputCapability=binary-input-v1&lease=exclusive`,
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
