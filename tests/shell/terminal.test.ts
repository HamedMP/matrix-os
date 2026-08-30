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
  const terminalRef = {
    workspaceId: `tws_${"a".repeat(32)}`,
    tabId: `tt_${"b".repeat(32)}`,
  };
  const refKey = `${terminalRef.workspaceId}:${terminalRef.tabId}`;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends input messages with correct shape", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal/tab");
    ws.send(JSON.stringify({ type: "input", terminalRef, data: "ls\r" }));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("input");
    expect(sent.data).toBe("ls\r");
    expect(sent.terminalRef).toEqual(terminalRef);
  });

  it("sends resize messages with cols and rows", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal/tab");
    ws.send(JSON.stringify({ type: "resize", terminalRef, mode: "soft", size: { cols: 80, rows: 24 } }));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("resize");
    expect(sent.mode).toBe("soft");
    expect(sent.size).toEqual({ cols: 80, rows: 24 });
  });

  it("receives output messages from server", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal/tab");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "output", terminalRef, revision: 3, seq: 8, data: "hello world\r\n" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "output", terminalRef, revision: 3, seq: 8, data: "hello world\r\n" });
  });

  it("receives exit messages from server", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal/tab");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "exit", terminalRef, revision: 4, exitCode: 0 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "exit", terminalRef, revision: 4, exitCode: 0 });
  });

  it("connects to the terminal WebSocket endpoint", () => {
    const ws = new MockTerminalWebSocket("ws://localhost:4000/ws/terminal/tab");
    expect(ws.url).toBe("ws://localhost:4000/ws/terminal/tab");
  });

  it("recognizes only stable workspace/tab refs and always uses the tab route", () => {
    expect(isCanonicalShellSessionId(refKey)).toBe(true);
    expect(isCanonicalShellSessionId("main")).toBe(false);
    expect(isCanonicalShellSessionId("term_observe_abc123")).toBe(false);
    expect(terminalWebSocketPathForSession(refKey)).toBe("/ws/terminal/tab");
    expect(terminalWebSocketPathForSession(null)).toBe("/ws/terminal/tab");
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
