import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TAIL_FROM_SEQ,
  ShellSocket,
  type ShellSocketOptions,
  type ShellSocketState,
  type WebSocketLike,
} from "@desktop/renderer/src/lib/shell-socket";

class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  frame(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  raw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(): void {
    this.onclose?.();
  }

  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  inputFrames(): string[] {
    return this.sentFrames()
      .filter((frame) => frame.type === "input")
      .map((frame) => String(frame.data));
  }

  resizeFrames(): Array<{ cols: number; rows: number }> {
    return this.sentFrames()
      .filter((frame) => frame.type === "resize")
      .map((frame) => ({ cols: Number(frame.cols), rows: Number(frame.rows) }));
  }
}

class FakeTimers {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly set = ((fn: () => void, ms?: number) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.now + (ms ?? 0), fn });
    return id;
  }) as unknown as typeof setTimeout;

  readonly clear = ((handle?: unknown) => {
    if (typeof handle === "number") this.timers.delete(handle);
  }) as unknown as typeof clearTimeout;

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const due = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.now = Math.max(this.now, dueAt);
      due?.fn();
    }
    this.now = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

interface RecordedEvents {
  states: Array<{ state: ShellSocketState; detail?: { code?: string } }>;
  outputs: Array<{ data: string; seq: number }>;
  gaps: number;
  exits: number[];
}

interface Harness {
  socket: ShellSocket;
  sockets: FakeWebSocket[];
  timers: FakeTimers;
  events: RecordedEvents;
  latest(): FakeWebSocket;
  stateNames(): ShellSocketState[];
}

function createHarness(overrides: Partial<ShellSocketOptions> = {}): Harness {
  const sockets: FakeWebSocket[] = [];
  const timers = new FakeTimers();
  const events: RecordedEvents = { states: [], outputs: [], gaps: 0, exits: [] };
  const socket = new ShellSocket({
    baseUrl: "https://app.matrix-os.com",
    sessionName: "main",
    runtimeSlot: "primary",
    events: {
      onState: (state, detail) => {
        events.states.push(detail === undefined ? { state } : { state, detail });
      },
      onOutput: (data, seq) => {
        events.outputs.push({ data, seq });
      },
      onGap: () => {
        events.gaps += 1;
      },
      onExit: (code) => {
        events.exits.push(code);
      },
    },
    createWebSocket: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    random: () => 0,
    ...overrides,
  });
  return {
    socket,
    sockets,
    timers,
    events,
    latest: () => {
      const ws = sockets[sockets.length - 1];
      if (!ws) throw new Error("no socket created yet");
      return ws;
    },
    stateNames: () => events.states.map((entry) => entry.state),
  };
}

function connectAndAttach(h: Harness, session = "main"): void {
  h.socket.connect();
  h.latest().open();
  h.latest().frame({ type: "attached", session, state: "running", fromSeq: 0 });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("ShellSocket URL building", () => {
  it("first connect attaches with the live-tail sentinel over wss", () => {
    const h = createHarness();
    h.socket.connect();
    expect(h.latest().url).toBe(
      `wss://app.matrix-os.com/ws/terminal/session?session=main&fromSeq=${LIVE_TAIL_FROM_SEQ}`,
    );
    expect(LIVE_TAIL_FROM_SEQ).toBe(9_007_199_254_740_991);
  });

  it("converts http base urls to ws and strips trailing slashes", () => {
    const h = createHarness({ baseUrl: "http://localhost:3001/" });
    h.socket.connect();
    expect(h.latest().url).toBe(
      `ws://localhost:3001/ws/terminal/session?session=main&fromSeq=${LIVE_TAIL_FROM_SEQ}`,
    );
  });

  it("appends runtime only for non-primary slots", () => {
    const nonPrimary = createHarness({ runtimeSlot: "vm-2" });
    nonPrimary.socket.connect();
    expect(nonPrimary.latest().url).toContain("&runtime=vm-2");

    const primary = createHarness();
    primary.socket.connect();
    expect(primary.latest().url).not.toContain("runtime=");
  });

  it("auto-creates with an encoded cwd and no fromSeq", () => {
    const h = createHarness({ sessionName: undefined, cwd: "/Users/h/my project" });
    h.socket.connect();
    expect(h.latest().url).toBe(
      "wss://app.matrix-os.com/ws/terminal?cwd=%2FUsers%2Fh%2Fmy%20project",
    );
  });

  it("appends runtime to the auto-create url for non-primary slots", () => {
    const h = createHarness({ sessionName: undefined, cwd: "/work", runtimeSlot: "vm-3" });
    h.socket.connect();
    expect(h.latest().url).toBe(
      "wss://app.matrix-os.com/ws/terminal?cwd=%2Fwork&runtime=vm-3",
    );
  });

  it("requires exactly one of sessionName or cwd", () => {
    const events = {
      onState: () => undefined,
      onOutput: () => undefined,
      onGap: () => undefined,
      onExit: () => undefined,
    };
    expect(
      () => new ShellSocket({ baseUrl: "https://x", runtimeSlot: "primary", events }),
    ).toThrow(/sessionName or cwd/);
    expect(
      () =>
        new ShellSocket({
          baseUrl: "https://x",
          sessionName: "a",
          cwd: "/b",
          runtimeSlot: "primary",
          events,
        }),
    ).toThrow(/sessionName or cwd/);
  });

  it("reconnects from lastSeq+1", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().frame({ type: "output", seq: 41, data: "x" });
    h.latest().serverClose();
    h.timers.advance(500);
    expect(h.sockets).toHaveLength(2);
    expect(h.latest().url).toBe(
      "wss://app.matrix-os.com/ws/terminal/session?session=main&fromSeq=42",
    );
  });

  it("reconnects with the live-tail sentinel when no output has arrived yet", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().serverClose();
    h.timers.advance(500);
    expect(h.sockets).toHaveLength(2);
    expect(h.latest().url).toBe(
      `wss://app.matrix-os.com/ws/terminal/session?session=main&fromSeq=${LIVE_TAIL_FROM_SEQ}`,
    );
  });

  it("reconnects an auto-created terminal by its attached session name", () => {
    const h = createHarness({ sessionName: undefined, cwd: "/work" });
    h.socket.connect();
    h.latest().open();
    h.latest().frame({ type: "attached", session: "w-1", state: "running", fromSeq: 0 });
    h.latest().frame({ type: "output", seq: 5, data: "x" });
    h.latest().serverClose();
    h.timers.advance(500);
    expect(h.latest().url).toBe(
      "wss://app.matrix-os.com/ws/terminal/session?session=w-1&fromSeq=6",
    );
  });
});

describe("ShellSocket server frames", () => {
  it("starts in connecting state and reaches attached", () => {
    const h = createHarness();
    expect(h.socket.state).toBe("connecting");
    connectAndAttach(h);
    expect(h.socket.state).toBe("attached");
    expect(h.stateNames()).toEqual(["connecting", "attached"]);
  });

  it("tracks lastSeq and emits output", () => {
    const h = createHarness();
    connectAndAttach(h);
    expect(h.socket.lastSeq).toBe(0);
    h.latest().frame({ type: "output", seq: 7, data: "hello" });
    h.latest().frame({ type: "output", seq: 8, data: "world" });
    expect(h.events.outputs).toEqual([
      { data: "hello", seq: 7 },
      { data: "world", seq: 8 },
    ]);
    expect(h.socket.lastSeq).toBe(8);
  });

  it("ends on exit with the exit code and never reconnects", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().frame({ type: "exit", code: 3 });
    expect(h.events.exits).toEqual([3]);
    expect(h.socket.state).toBe("ended");
    h.timers.advance(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("ignores pong frames", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().frame({ type: "pong" });
    expect(h.stateNames()).toEqual(["connecting", "attached"]);
    expect(h.events.outputs).toHaveLength(0);
  });

  it("emits onGap for replay-evicted", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().frame({ type: "replay-evicted", fromSeq: 1, nextSeq: 60 });
    expect(h.events.gaps).toBe(1);
  });

  it("treats session_not_found, invalid_request, and attach_failed as fatal and never reconnects", () => {
    for (const code of ["session_not_found", "invalid_request", "attach_failed"]) {
      const h = createHarness();
      h.socket.connect();
      h.latest().open();
      h.latest().frame({ type: "error", code, message: "nope" });
      expect(h.socket.state).toBe("fatal");
      expect(h.events.states.at(-1)).toEqual({ state: "fatal", detail: { code } });
      h.latest().serverClose();
      h.timers.advance(120_000);
      expect(h.sockets).toHaveLength(1);
    }
  });

  it("logs and continues on non-fatal error codes", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().frame({ type: "error", code: "buffer_overflow", message: "slow down" });
    expect(h.socket.state).toBe("attached");
    expect(warnSpy).toHaveBeenCalled();
    h.latest().frame({ type: "output", seq: 1, data: "still alive" });
    expect(h.events.outputs).toEqual([{ data: "still alive", seq: 1 }]);
  });

  it("keeps the handshake timeout active after a pre-attach non-fatal error", () => {
    const h = createHarness();
    h.socket.connect();
    h.latest().open();
    h.latest().frame({ type: "error", code: "buffer_overflow", message: "slow down" });

    h.timers.advance(499);
    expect(h.sockets).toHaveLength(1);
    h.timers.advance(1);

    expect(h.socket.state).toBe("reconnecting");
    h.timers.advance(500);
    expect(h.sockets).toHaveLength(2);
  });

  it("ignores malformed JSON frames without crashing", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().raw("{not json");
    expect(warnSpy).toHaveBeenCalled();
    h.latest().frame({ type: "output", seq: 2, data: "ok" });
    expect(h.events.outputs).toEqual([{ data: "ok", seq: 2 }]);
  });

  it("ignores non-string and non-object frames", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().raw(42);
    h.latest().raw(new ArrayBuffer(4));
    h.latest().frame("just-a-string");
    h.latest().frame(null);
    expect(h.events.outputs).toHaveLength(0);
    expect(h.socket.state).toBe("attached");
  });

  it("ignores unknown frame types and invalid field shapes", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().frame({ type: "mystery" });
    h.latest().frame({ type: "output", seq: "nan", data: "x" });
    h.latest().frame({ type: "output", seq: 1 });
    h.latest().frame({ type: "exit", code: "one" });
    expect(h.events.outputs).toHaveLength(0);
    expect(h.events.exits).toHaveLength(0);
    expect(h.socket.state).toBe("attached");
  });
});

describe("ShellSocket reconnect", () => {
  it("reconnects after an unexpected close with the base 500ms delay", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().serverClose();
    expect(h.socket.state).toBe("reconnecting");
    h.timers.advance(499);
    expect(h.sockets).toHaveLength(1);
    h.timers.advance(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("reconnects when the websocket opens but never sends an attach frame", () => {
    const h = createHarness();
    h.socket.connect();
    h.latest().open();

    h.timers.advance(499);
    expect(h.sockets).toHaveLength(1);
    expect(h.socket.state).toBe("connecting");

    h.timers.advance(1);
    expect(h.socket.state).toBe("reconnecting");
    h.timers.advance(500);
    expect(h.sockets).toHaveLength(2);
  });

  it("doubles the backoff and reports connection-lost after 2 failed attempts while still retrying", () => {
    const h = createHarness();
    connectAndAttach(h);

    h.latest().serverClose();
    h.timers.advance(500);
    expect(h.sockets).toHaveLength(2);

    h.latest().serverClose();
    expect(h.stateNames()).not.toContain("connection-lost");
    h.timers.advance(999);
    expect(h.sockets).toHaveLength(2);
    h.timers.advance(1);
    expect(h.sockets).toHaveLength(3);

    h.latest().serverClose();
    expect(h.socket.state).toBe("connection-lost");
    h.timers.advance(2000);
    expect(h.sockets).toHaveLength(4);
  });

  it("caps the retry interval at 30s and keeps retrying", () => {
    const h = createHarness();
    connectAndAttach(h);
    const delays = [500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    for (const delay of delays) {
      h.latest().serverClose();
      h.timers.advance(delay - 1);
      const before = h.sockets.length;
      h.timers.advance(1);
      expect(h.sockets.length).toBe(before + 1);
    }
  });

  it("applies jitter as delay * (1 - 0.5 * random())", () => {
    const h = createHarness({ random: () => 1 });
    connectAndAttach(h);
    h.latest().serverClose();
    h.timers.advance(249);
    expect(h.sockets).toHaveLength(1);
    h.timers.advance(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("resets the attempt counter on a successful attach", () => {
    const h = createHarness();
    connectAndAttach(h);

    h.latest().serverClose();
    h.timers.advance(500);
    h.latest().serverClose();
    h.timers.advance(1000);
    h.latest().serverClose();
    expect(h.socket.state).toBe("connection-lost");
    h.timers.advance(2000);

    h.latest().open();
    h.latest().frame({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    expect(h.socket.state).toBe("attached");

    h.latest().serverClose();
    expect(h.socket.state).toBe("reconnecting");
    h.timers.advance(499);
    expect(h.sockets).toHaveLength(4);
    h.timers.advance(1);
    expect(h.sockets).toHaveLength(5);
  });

  it("schedules a retry when the websocket factory throws", () => {
    let fail = true;
    const sockets: FakeWebSocket[] = [];
    const h = createHarness({
      createWebSocket: (url) => {
        if (fail) {
          fail = false;
          throw new Error("boom");
        }
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });
    h.socket.connect();
    expect(h.socket.state).toBe("reconnecting");
    h.timers.advance(500);
    expect(sockets).toHaveLength(1);
  });
});

describe("ShellSocket resize coalescing", () => {
  it("debounces at 220ms during the startup window", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.socket.resize(120, 40);
    h.timers.advance(90);
    expect(h.latest().resizeFrames()).toHaveLength(0);
    h.timers.advance(130);
    expect(h.latest().resizeFrames()).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("debounces at 90ms once the startup window settles (300ms after attach)", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.timers.advance(300);
    h.socket.resize(100, 30);
    h.timers.advance(89);
    expect(h.latest().resizeFrames()).toHaveLength(0);
    h.timers.advance(1);
    expect(h.latest().resizeFrames()).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("coalesces rapid resizes into one send of the latest dims", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.timers.advance(300);
    h.socket.resize(100, 30);
    h.timers.advance(50);
    h.socket.resize(101, 31);
    h.timers.advance(90);
    expect(h.latest().resizeFrames()).toEqual([{ cols: 101, rows: 31 }]);
  });

  it("does not resend unchanged dims", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.timers.advance(300);
    h.socket.resize(80, 24);
    h.timers.advance(90);
    h.socket.resize(80, 24);
    h.timers.advance(90);
    expect(h.latest().resizeFrames()).toEqual([{ cols: 80, rows: 24 }]);
  });

  it("clamps cols to 1..500 and rows to 1..200", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.timers.advance(300);
    h.socket.resize(9999, 9999);
    h.timers.advance(90);
    h.socket.resize(0, -5);
    h.timers.advance(90);
    expect(h.latest().resizeFrames()).toEqual([
      { cols: 500, rows: 200 },
      { cols: 1, rows: 1 },
    ]);
  });

  it("sends last known dims 900ms after attach when none were sent", () => {
    const h = createHarness();
    h.socket.connect();
    h.socket.resize(90, 30);
    h.timers.advance(220);
    h.latest().open();
    h.latest().frame({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    h.timers.advance(899);
    expect(h.latest().resizeFrames()).toHaveLength(0);
    h.timers.advance(1);
    expect(h.latest().resizeFrames()).toEqual([{ cols: 90, rows: 30 }]);
  });

  it("skips the 900ms fallback when a resize was already sent after attach", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.socket.resize(120, 40);
    h.timers.advance(220);
    expect(h.latest().resizeFrames()).toHaveLength(1);
    h.timers.advance(680);
    expect(h.latest().resizeFrames()).toHaveLength(1);
  });

  it("skips the 900ms fallback when the caller never provided dims", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.timers.advance(900);
    expect(h.latest().resizeFrames()).toHaveLength(0);
  });

  it("resends dims to a fresh connection after reconnect via the fallback", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.timers.advance(300);
    h.socket.resize(100, 30);
    h.timers.advance(90);
    expect(h.latest().resizeFrames()).toEqual([{ cols: 100, rows: 30 }]);

    h.latest().serverClose();
    h.timers.advance(500);
    h.latest().open();
    h.latest().frame({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    h.timers.advance(900);
    expect(h.latest().resizeFrames()).toEqual([{ cols: 100, rows: 30 }]);
  });
});

describe("ShellSocket input", () => {
  it("chunks large input into <=32768-char pieces", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.socket.sendInput("a".repeat(70_000));
    const chunks = h.latest().inputFrames();
    expect(chunks.map((chunk) => chunk.length)).toEqual([32_768, 32_768, 4464]);
    expect(chunks.join("")).toBe("a".repeat(70_000));
  });

  it("buffers input typed before attach and flushes it in order on attach", () => {
    const h = createHarness();
    h.socket.connect();
    h.socket.sendInput("hel");
    h.socket.sendInput("lo");
    expect(h.latest().sent).toHaveLength(0);
    h.latest().open();
    h.latest().frame({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    expect(h.latest().inputFrames()).toEqual(["hel", "lo"]);
  });

  it("caps the pre-attach buffer at 64 chunks, dropping the oldest", () => {
    const h = createHarness();
    h.socket.connect();
    for (let i = 0; i < 70; i += 1) {
      h.socket.sendInput(`c${i}`);
    }
    h.latest().open();
    h.latest().frame({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    const flushed = h.latest().inputFrames();
    expect(flushed).toHaveLength(64);
    expect(flushed[0]).toBe("c6");
    expect(flushed.at(-1)).toBe("c69");
  });

  it("ignores input after the session ends", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().frame({ type: "exit", code: 0 });
    const before = h.latest().sent.length;
    h.socket.sendInput("ghost");
    expect(h.latest().sent).toHaveLength(before);
  });
});

describe("ShellSocket detach and dispose", () => {
  it("detach sends a detach frame, closes, ends, and never reconnects", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.socket.detach();
    expect(h.latest().sentFrames()).toContainEqual({ type: "detach" });
    expect(h.latest().closed).toBe(true);
    expect(h.socket.state).toBe("ended");
    expect(h.timers.pendingCount).toBe(0);
    h.timers.advance(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("detach during a pending reconnect sends a detach frame through a cleanup attach", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().serverClose();
    expect(h.socket.state).toBe("reconnecting");
    h.socket.detach();
    expect(h.socket.state).toBe("ended");
    expect(h.sockets).toHaveLength(2);
    h.latest().open();
    h.latest().frame({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    expect(h.latest().sentFrames()).toContainEqual({ type: "detach" });
    expect(h.latest().closed).toBe(true);
    h.timers.advance(120_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("dispose clears every timer and emits no further events", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.socket.resize(100, 30);
    expect(h.timers.pendingCount).toBeGreaterThan(0);
    const statesBefore = h.events.states.length;
    h.socket.dispose();
    expect(h.timers.pendingCount).toBe(0);
    h.timers.advance(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.events.states).toHaveLength(statesBefore);
    expect(h.latest().closed).toBe(true);
  });

  it("dispose during a pending reconnect clears the retry timer", () => {
    const h = createHarness();
    connectAndAttach(h);
    h.latest().serverClose();
    expect(h.timers.pendingCount).toBeGreaterThan(0);
    h.socket.dispose();
    expect(h.timers.pendingCount).toBe(0);
    h.timers.advance(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("connect is a no-op when called twice or after dispose", () => {
    const h = createHarness();
    h.socket.connect();
    h.socket.connect();
    expect(h.sockets).toHaveLength(1);

    const disposed = createHarness();
    disposed.socket.connect();
    disposed.socket.dispose();
    disposed.socket.connect();
    expect(disposed.sockets).toHaveLength(1);
  });
});
