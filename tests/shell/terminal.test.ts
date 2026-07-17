import { afterEach, describe, it, expect, vi } from "vitest";
import {
  isCanonicalShellSessionId,
  terminalWebSocketPathForSession,
} from "../../shell/src/components/terminal/terminal-session-id.js";
import { twoWordSessionName } from "../../shell/src/components/terminal/terminal-session-names.js";

class MockTerminalWebSocket {
  static instances: MockTerminalWebSocket[] = [];
  readyState = 1;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockTerminalWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("Terminal WebSocket protocol", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends input messages with correct shape", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal");
    ws.send(JSON.stringify({ type: "input", data: "ls\r" }));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("input");
    expect(sent.data).toBe("ls\r");
  });

  it("sends resize messages with cols and rows", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal");
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("resize");
    expect(sent.cols).toBe(80);
    expect(sent.rows).toBe(24);
  });

  it("receives output messages from server", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "output", data: "hello world\r\n" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "output", data: "hello world\r\n" });
  });

  it("receives exit messages from server", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "exit", code: 0 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "exit", code: 0 });
  });

  it("connects to the terminal WebSocket endpoint", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal");
    expect(ws.url).toBe("ws://localhost:4000/ws/terminal");
  });

  it("uses canonical zellij websocket paths only for shell session names", () => {
    expect(isCanonicalShellSessionId("main")).toBe(true);
    expect(isCanonicalShellSessionId("setup-1")).toBe(true);
    expect(isCanonicalShellSessionId("1test")).toBe(true);
    expect(isCanonicalShellSessionId("term_observe_abc123")).toBe(false);
    expect(isCanonicalShellSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(terminalWebSocketPathForSession("main")).toBe("/ws/terminal/session");
    expect(terminalWebSocketPathForSession("1test")).toBe("/ws/terminal/session");
    expect(terminalWebSocketPathForSession("term_observe_abc123")).toBe("/ws/terminal");
    expect(terminalWebSocketPathForSession("550e8400-e29b-41d4-a716-446655440000")).toBe("/ws/terminal");
    expect(terminalWebSocketPathForSession(null)).toBe("/ws/terminal");
  });

  it("uses two-word friendly terminal session names by default", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(twoWordSessionName()).toBe("swift-falcon");
  });

  it("keeps two-word friendly terminal session names even for repeated candidates", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(twoWordSessionName()).toBe("swift-falcon");
  });
});
