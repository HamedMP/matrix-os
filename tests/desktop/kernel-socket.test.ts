import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKernelWsUrl,
  KernelSocket,
  type KernelConnectionState,
  type KernelServerMessage,
  type WebSocketLike,
} from "@desktop/renderer/src/lib/kernel-socket";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(): void {
    this.close();
  }
}

interface ScheduledTimer {
  id: number;
  fn: () => void;
  delay: number;
  cleared: boolean;
  fired: boolean;
}

function createFakeTimers() {
  const scheduled: ScheduledTimer[] = [];
  let nextId = 1;
  const setTimeoutFn = ((fn: () => void, delay?: number) => {
    const timer: ScheduledTimer = {
      id: nextId++,
      fn,
      delay: delay ?? 0,
      cleared: false,
      fired: false,
    };
    scheduled.push(timer);
    return timer.id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((id?: unknown) => {
    const timer = scheduled.find((t) => t.id === id);
    if (timer) timer.cleared = true;
  }) as typeof clearTimeout;
  function runNext(): void {
    const timer = scheduled.find((t) => !t.cleared && !t.fired);
    if (!timer) throw new Error("no pending timer");
    timer.fired = true;
    timer.fn();
  }
  function pending(): ScheduledTimer[] {
    return scheduled.filter((t) => !t.cleared && !t.fired);
  }
  return { scheduled, setTimeoutFn, clearTimeoutFn, runNext, pending };
}

function createHarness(overrides?: { runtimeSlot?: string; random?: () => number }) {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  const timers = createFakeTimers();
  const socket = new KernelSocket({
    baseUrl: "https://app.matrix-os.com",
    runtimeSlot: overrides?.runtimeSlot ?? "primary",
    createWebSocket: (url) => {
      urls.push(url);
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: overrides?.random ?? (() => 1),
  });
  return { socket, sockets, urls, timers, last: () => sockets[sockets.length - 1]! };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildKernelWsUrl", () => {
  it("converts http(s) to ws(s) and appends /ws", () => {
    expect(buildKernelWsUrl("https://app.matrix-os.com", "primary")).toBe(
      "wss://app.matrix-os.com/ws",
    );
    expect(buildKernelWsUrl("http://localhost:4000", "primary")).toBe("ws://localhost:4000/ws");
  });

  it("appends runtime only when slot is not primary", () => {
    expect(buildKernelWsUrl("https://app.matrix-os.com", "vm-2")).toBe(
      "wss://app.matrix-os.com/ws?runtime=vm-2",
    );
  });

  it("strips a trailing slash from the base", () => {
    expect(buildKernelWsUrl("https://app.matrix-os.com/", "primary")).toBe(
      "wss://app.matrix-os.com/ws",
    );
  });
});

describe("KernelSocket: connection and routing", () => {
  it("does not invoke browser timers with the socket as their receiver", () => {
    const sockets: FakeWebSocket[] = [];
    const strictTimer = vi.fn(function (this: unknown, fn: () => void) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    vi.stubGlobal("setTimeout", strictTimer);
    const socket = new KernelSocket({
      baseUrl: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      createWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next;
      },
    });

    socket.connect();
    expect(() => sockets[0]!.fail()).not.toThrow();
    expect(strictTimer).toHaveBeenCalledOnce();
    socket.dispose();
  });

  it("connects to the built URL", () => {
    const h = createHarness({ runtimeSlot: "vm-2" });
    h.socket.connect();
    expect(h.urls).toEqual(["wss://app.matrix-os.com/ws?runtime=vm-2"]);
  });

  it("routes parsed messages to all subscribers", () => {
    const h = createHarness();
    const seen1: KernelServerMessage[] = [];
    const seen2: KernelServerMessage[] = [];
    h.socket.subscribe((m) => seen1.push(m));
    h.socket.subscribe((m) => seen2.push(m));
    h.socket.connect();
    h.last().open();
    h.last().message(JSON.stringify({ type: "kernel:text", text: "hi", requestId: "r1" }));
    expect(seen1).toEqual([{ type: "kernel:text", text: "hi", requestId: "r1" }]);
    expect(seen2).toEqual(seen1);
  });

  it("stops routing after unsubscribe", () => {
    const h = createHarness();
    const seen: KernelServerMessage[] = [];
    const unsubscribe = h.socket.subscribe((m) => seen.push(m));
    h.socket.connect();
    h.last().open();
    unsubscribe();
    h.last().message(JSON.stringify({ type: "pong" }));
    expect(seen).toEqual([]);
  });

  it("passes unknown message types through as-is for forward compat", () => {
    const h = createHarness();
    const seen: KernelServerMessage[] = [];
    h.socket.subscribe((m) => seen.push(m));
    h.socket.connect();
    h.last().open();
    h.last().message(JSON.stringify({ type: "future:event", payload: { x: 1 } }));
    expect(seen).toEqual([{ type: "future:event", payload: { x: 1 } }]);
  });

  it("ignores malformed frames", () => {
    const h = createHarness();
    const seen: KernelServerMessage[] = [];
    h.socket.subscribe((m) => seen.push(m));
    h.socket.connect();
    h.last().open();
    h.last().message("{not json");
    h.last().message(JSON.stringify({ noType: true }));
    h.last().message(JSON.stringify({ type: "kernel:text" })); // known type missing required field
    h.last().message(JSON.stringify(["array"]));
    h.last().message(12345);
    expect(seen).toEqual([]);
  });

  it("isolates subscriber failures so later subscribers still receive", () => {
    const h = createHarness();
    const seen: KernelServerMessage[] = [];
    h.socket.subscribe(() => {
      throw new Error("subscriber boom");
    });
    h.socket.subscribe((m) => seen.push(m));
    h.socket.connect();
    h.last().open();
    h.last().message(JSON.stringify({ type: "pong" }));
    expect(seen).toEqual([{ type: "pong" }]);
  });

  it("caps the subscriber registry at 64", () => {
    const h = createHarness();
    for (let i = 0; i < 64; i++) h.socket.subscribe(() => {});
    expect(() => h.socket.subscribe(() => {})).toThrow();
  });
});

describe("KernelSocket: send queue", () => {
  it("queues sends while not connected and drains on open in order", () => {
    const h = createHarness();
    h.socket.connect();
    h.socket.send({ type: "message", text: "a", requestId: "r1" });
    h.socket.send({ type: "ping" });
    expect(h.last().sent).toEqual([]);
    h.last().open();
    expect(h.last().sent.map((s) => JSON.parse(s))).toEqual([
      { type: "message", text: "a", requestId: "r1" },
      { type: "ping" },
    ]);
  });

  it("sends immediately while connected", () => {
    const h = createHarness();
    h.socket.connect();
    h.last().open();
    h.socket.send({ type: "abort", requestId: "r1" });
    expect(JSON.parse(h.last().sent[0]!)).toEqual({ type: "abort", requestId: "r1" });
  });

  it("caps the queue at 32, dropping the oldest with a warning", () => {
    const h = createHarness();
    h.socket.connect();
    for (let i = 0; i < 40; i++) {
      h.socket.send({ type: "message", text: `m${i}`, requestId: `r${i}` });
    }
    expect(console.warn).toHaveBeenCalled();
    h.last().open();
    const texts = h.last().sent.map((s) => (JSON.parse(s) as { text: string }).text);
    expect(texts).toHaveLength(32);
    expect(texts[0]).toBe("m8");
    expect(texts[31]).toBe("m39");
  });

  it("drains queued messages after a reconnect", () => {
    const h = createHarness();
    h.socket.connect();
    h.last().open();
    h.last().fail();
    h.socket.send({ type: "message", text: "while-down", requestId: "r9" });
    h.timers.runNext();
    h.last().open();
    expect(JSON.parse(h.last().sent[0]!)).toEqual({
      type: "message",
      text: "while-down",
      requestId: "r9",
    });
  });
});

describe("KernelSocket: reconnect backoff and state", () => {
  it("starts connecting, then connected on open", () => {
    const h = createHarness();
    const states: KernelConnectionState[] = [];
    h.socket.onStateChange((s) => states.push(s));
    expect(h.socket.state).toBe("connecting");
    h.socket.connect();
    h.last().open();
    expect(h.socket.state).toBe("connected");
    expect(states).toContain("connected");
  });

  it("follows the 500ms * 2^n schedule capped at 30s (random=1)", () => {
    const h = createHarness({ random: () => 1 });
    h.socket.connect();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      h.last().fail();
      const pending = h.timers.pending();
      expect(pending).toHaveLength(1);
      delays.push(pending[0]!.delay);
      h.timers.runNext();
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("applies 0.5 jitter as the lower bound (random=0 halves the delay)", () => {
    const h = createHarness({ random: () => 0 });
    h.socket.connect();
    h.last().fail();
    expect(h.timers.pending()[0]!.delay).toBe(250);
  });

  it("goes reconnecting on first failures, offline after 3, but keeps retrying", () => {
    const h = createHarness();
    h.socket.connect();
    h.last().fail();
    expect(h.socket.state).toBe("reconnecting");
    h.timers.runNext();
    h.last().fail();
    expect(h.socket.state).toBe("reconnecting");
    h.timers.runNext();
    h.last().fail();
    expect(h.socket.state).toBe("offline");
    expect(h.timers.pending()).toHaveLength(1);
    h.timers.runNext();
    h.last().fail();
    expect(h.socket.state).toBe("offline");
    expect(h.timers.pending()).toHaveLength(1);
  });

  it("resets backoff and failure count after a successful connection", () => {
    const h = createHarness();
    h.socket.connect();
    h.last().fail();
    h.timers.runNext();
    h.last().fail();
    h.timers.runNext();
    h.last().open();
    expect(h.socket.state).toBe("connected");
    h.last().fail();
    expect(h.socket.state).toBe("reconnecting");
    expect(h.timers.pending()[0]!.delay).toBe(500);
  });

  it("unsubscribing a state handler stops notifications", () => {
    const h = createHarness();
    const states: KernelConnectionState[] = [];
    const off = h.socket.onStateChange((s) => states.push(s));
    off();
    h.socket.connect();
    h.last().open();
    expect(states).toEqual([]);
  });
});

describe("KernelSocket: dispose", () => {
  it("clears pending reconnect timers and closes the socket", () => {
    const h = createHarness();
    h.socket.connect();
    h.last().fail();
    expect(h.timers.pending()).toHaveLength(1);
    h.socket.dispose();
    expect(h.timers.pending()).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });

  it("does not reconnect or deliver messages after dispose", () => {
    const h = createHarness();
    const seen: KernelServerMessage[] = [];
    h.socket.subscribe((m) => seen.push(m));
    h.socket.connect();
    const ws = h.last();
    ws.open();
    h.socket.dispose();
    ws.message(JSON.stringify({ type: "pong" }));
    expect(seen).toEqual([]);
    expect(h.timers.pending()).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
    h.socket.connect();
    expect(h.sockets).toHaveLength(1);
  });
});
