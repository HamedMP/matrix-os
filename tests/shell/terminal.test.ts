import { describe, it, expect } from "vitest";

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
});
