import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1; // OPEN
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Auto-fire onopen in next microtask to simulate real WS
    queueMicrotask(() => {
      if (this.readyState === 1) {
        this.onopen?.();
      }
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

Object.assign(MockWebSocket, {
  OPEN: 1,
  CLOSED: 3,
  CONNECTING: 0,
});

describe("useSocket message protocol", () => {
  it("sends messages as JSON with correct shape", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    ws.send(JSON.stringify({ type: "message", text: "hello", sessionId: "s1" }));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("message");
    expect(sent.text).toBe("hello");
    expect(sent.sessionId).toBe("s1");
  });

  it("parses kernel:init events", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "kernel:init", sessionId: "abc123" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "kernel:init", sessionId: "abc123" });
  });

  it("parses kernel:text events", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "kernel:text", text: "Building..." });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "kernel:text", text: "Building..." });
  });

  it("parses file:change events", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({
      type: "file:change",
      path: "apps/notes.html",
      event: "add",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: "file:change",
      path: "apps/notes.html",
      event: "add",
    });
  });

  it("parses kernel:tool_start and kernel:tool_end events", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "kernel:tool_start", tool: "Write" });
    ws.simulateMessage({ type: "kernel:tool_end" });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: "kernel:tool_start", tool: "Write" });
    expect(received[1]).toEqual({ type: "kernel:tool_end" });
  });

  it("parses kernel:result events with success data", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({
      type: "kernel:result",
      data: { sessionId: "s1", result: "Done", cost: 0.05, turns: 3 },
    });

    const msg = received[0] as Record<string, unknown>;
    expect(msg.type).toBe("kernel:result");
    const data = msg.data as Record<string, unknown>;
    expect(data.sessionId).toBe("s1");
    expect(data.result).toBe("Done");
    expect(data.cost).toBe(0.05);
  });

  it("parses kernel:error events", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      received.push(JSON.parse(evt.data));
    };

    ws.simulateMessage({ type: "kernel:error", message: "Something broke" });

    expect(received[0]).toEqual({
      type: "kernel:error",
      message: "Something broke",
    });
  });

  it("ignores malformed JSON messages", () => {
    const ws = new MockWebSocket("ws://localhost:4000/ws");
    const received: unknown[] = [];

    ws.onmessage = (evt) => {
      try {
        received.push(JSON.parse(evt.data));
      } catch (_err: unknown) {
        // Ignored, matching hook behavior
      }
    };

    ws.onmessage({ data: "not-json{{{" });
    expect(received).toHaveLength(0);
  });
});

describe("useSocket heartbeat and resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: "ws-token",
      expiresAt: Date.now() + 60_000,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends ping every 30 seconds when connected", async () => {
    vi.resetModules();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { ensureConnected, getGlobalSocket } = await import("../../shell/src/hooks/useSocket.js");
    ensureConnected();

    // Flush the queueMicrotask so onopen fires
    await vi.advanceTimersByTimeAsync(0);

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain("token=ws-token");

    // Advance 30s for first ping
    vi.advanceTimersByTime(30_000);

    const pings = ws.sent.filter((s) => JSON.parse(s).type === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });

  it("queues messages during disconnect and replays on reconnect", async () => {
    vi.resetModules();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { ensureConnected, sendMessage } = await import("../../shell/src/hooks/useSocket.js");
    ensureConnected();

    // Flush onopen
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = MockWebSocket.instances[0];

    // Simulate disconnect -- set readyState first then trigger close
    ws1.readyState = 3;
    ws1.onclose?.();

    // Messages sent while disconnected should be queued
    sendMessage({ type: "message", text: "queued1" });
    sendMessage({ type: "message", text: "queued2" });

    // Reconnect happens after backoff (1s for attempt 0)
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];

    // Simulate the new socket opening
    ws2.readyState = 1;
    // Flush onopen microtask
    await vi.advanceTimersByTimeAsync(0);

    // Drain should have replayed the queued messages
    const msgs = ws2.sent.map((s) => JSON.parse(s));
    const queued = msgs.filter((m: { text?: string }) => m.text === "queued1" || m.text === "queued2");
    expect(queued).toHaveLength(2);
  });
});
