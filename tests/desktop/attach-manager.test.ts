import { describe, expect, it } from "vitest";
import type {
  ShellSocketEvents,
  ShellSocketState,
} from "@desktop/renderer/src/lib/shell-socket";
import {
  AttachManager,
  type SocketControl,
} from "@desktop/renderer/src/features/terminal/attach-manager";

class FakeSocketControl implements SocketControl {
  connected = 0;
  detached = 0;
  disposedCount = 0;
  readonly inputs: string[] = [];
  readonly binaryInputs: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];

  constructor(
    readonly sessionName: string,
    readonly events: ShellSocketEvents,
    readonly chatId?: string,
  ) {}

  connect(): void {
    this.connected += 1;
  }

  sendInput(data: string): void {
    this.inputs.push(data);
  }

  sendBinary(data: string): void {
    this.binaryInputs.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  detach(): void {
    this.detached += 1;
  }

  dispose(): void {
    this.disposedCount += 1;
  }
}

interface RecordedEvents {
  states: ShellSocketState[];
  outputs: Array<{ data: string; seq: number }>;
  gaps: number;
  exits: number[];
}

function recordingEvents(): { calls: RecordedEvents; events: ShellSocketEvents } {
  const calls: RecordedEvents = { states: [], outputs: [], gaps: 0, exits: [] };
  const events: ShellSocketEvents = {
    onState: (state) => {
      calls.states.push(state);
    },
    onOutput: (data, seq) => {
      calls.outputs.push({ data: typeof data === "string" ? data : new TextDecoder().decode(data), seq });
    },
    onGap: () => {
      calls.gaps += 1;
    },
    onExit: (code) => {
      calls.exits.push(code);
    },
  };
  return { calls, events };
}

function createManager(bufferCacheCap?: number, maxLive?: number): {
  manager: AttachManager;
  created: FakeSocketControl[];
} {
  const created: FakeSocketControl[] = [];
  const manager = new AttachManager({
    bufferCacheCap,
    maxLive,
    createSocket: (sessionName, events, chatId) => {
      const socket = new FakeSocketControl(sessionName, events, chatId);
      created.push(socket);
      return socket;
    },
  });
  return { manager, created };
}

describe("AttachManager single-active invariant", () => {
  it("creates and connects one socket per attach", () => {
    const { manager, created } = createManager();
    const { events } = recordingEvents();
    manager.attach("alpha", events);
    expect(created).toHaveLength(1);
    expect(created[0]?.connected).toBe(1);
    expect(manager.activeSessionName).toBe("alpha");
  });

  it("forwards optional canonical Chat authorization context to the socket", () => {
    const { manager, created } = createManager();
    manager.attach("alpha", recordingEvents().events, undefined, "chat_selected");

    expect(created[0]?.chatId).toBe("chat_selected");
    expect(created[0]?.connected).toBe(1);
  });

  it("attaching B detaches and disposes A's socket", () => {
    const { manager, created } = createManager();
    manager.attach("alpha", recordingEvents().events);
    manager.attach("beta", recordingEvents().events);
    expect(created).toHaveLength(2);
    expect(created[0]?.detached).toBe(1);
    expect(created[0]?.disposedCount).toBe(1);
    expect(created[1]?.detached).toBe(0);
    expect(created[1]?.disposedCount).toBe(0);
    expect(created[1]?.connected).toBe(1);
    expect(manager.activeSessionName).toBe("beta");
  });

  it("re-attaching the same session replaces the socket", () => {
    const { manager, created } = createManager();
    manager.attach("alpha", recordingEvents().events);
    manager.attach("alpha", recordingEvents().events);
    expect(created).toHaveLength(2);
    expect(created[0]?.disposedCount).toBe(1);
    expect(manager.activeSessionName).toBe("alpha");
  });
});

describe("AttachManager generation guard", () => {
  it("forwards events from the active socket", () => {
    const { manager, created } = createManager();
    const recorder = recordingEvents();
    manager.attach("alpha", recorder.events);
    created[0]?.events.onState("attached");
    created[0]?.events.onOutput("hi", 1);
    created[0]?.events.onGap();
    created[0]?.events.onExit(0);
    expect(recorder.calls.states).toEqual(["attached"]);
    expect(recorder.calls.outputs).toEqual([{ data: "hi", seq: 1 }]);
    expect(recorder.calls.gaps).toBe(1);
    expect(recorder.calls.exits).toEqual([0]);
  });

  it("drops stale events from a previous generation after switching", () => {
    const { manager, created } = createManager();
    const recorderA = recordingEvents();
    const recorderB = recordingEvents();
    manager.attach("alpha", recorderA.events);
    manager.attach("beta", recorderB.events);

    created[0]?.events.onState("ended");
    created[0]?.events.onOutput("stale", 9);
    created[0]?.events.onGap();
    created[0]?.events.onExit(1);
    expect(recorderA.calls.states).toHaveLength(0);
    expect(recorderA.calls.outputs).toHaveLength(0);
    expect(recorderA.calls.gaps).toBe(0);
    expect(recorderA.calls.exits).toHaveLength(0);

    created[1]?.events.onOutput("live", 1);
    expect(recorderB.calls.outputs).toEqual([{ data: "live", seq: 1 }]);
  });

  it("routes write and resize through the active socket and ignores stale attachments", () => {
    const { manager, created } = createManager();
    const a = manager.attach("alpha", recordingEvents().events);
    a.write("first");
    a.writeBinary("\x1b]10;?\x07");
    a.resize(80, 24);
    expect(created[0]?.inputs).toEqual(["first"]);
    expect(created[0]?.binaryInputs).toEqual(["\x1b]10;?\x07"]);
    expect(created[0]?.resizes).toEqual([{ cols: 80, rows: 24 }]);

    const b = manager.attach("beta", recordingEvents().events);
    a.write("stale");
    a.writeBinary("stale-binary");
    a.resize(100, 30);
    expect(created[0]?.inputs).toEqual(["first"]);
    expect(created[0]?.binaryInputs).toEqual(["\x1b]10;?\x07"]);
    expect(created[0]?.resizes).toEqual([{ cols: 80, rows: 24 }]);

    b.write("live");
    b.writeBinary("live-binary");
    expect(created[1]?.inputs).toEqual(["live"]);
    expect(created[1]?.binaryInputs).toEqual(["live-binary"]);
    expect(b.sessionName).toBe("beta");
  });
});

describe("AttachManager buffer cache (LRU)", () => {
  it("returns null for unknown sessions", () => {
    const { manager } = createManager();
    expect(manager.getCachedBuffer("nope")).toBeNull();
  });

  it("evicts the oldest entry past the cap", () => {
    const { manager } = createManager(2);
    manager.cacheBuffer("a", "buf-a");
    manager.cacheBuffer("b", "buf-b");
    manager.cacheBuffer("c", "buf-c");
    expect(manager.getCachedBuffer("a")).toBeNull();
    expect(manager.getCachedBuffer("b")).toBe("buf-b");
    expect(manager.getCachedBuffer("c")).toBe("buf-c");
  });

  it("getCachedBuffer refreshes recency", () => {
    const { manager } = createManager(2);
    manager.cacheBuffer("a", "buf-a");
    manager.cacheBuffer("b", "buf-b");
    expect(manager.getCachedBuffer("a")).toBe("buf-a");
    manager.cacheBuffer("c", "buf-c");
    expect(manager.getCachedBuffer("b")).toBeNull();
    expect(manager.getCachedBuffer("a")).toBe("buf-a");
    expect(manager.getCachedBuffer("c")).toBe("buf-c");
  });

  it("cacheBuffer on an existing key updates the value and refreshes recency", () => {
    const { manager } = createManager(2);
    manager.cacheBuffer("a", "old-a");
    manager.cacheBuffer("b", "buf-b");
    manager.cacheBuffer("a", "new-a");
    manager.cacheBuffer("c", "buf-c");
    expect(manager.getCachedBuffer("b")).toBeNull();
    expect(manager.getCachedBuffer("a")).toBe("new-a");
  });

  it("defaults the cap to 8", () => {
    const { manager } = createManager();
    for (let i = 1; i <= 9; i += 1) {
      manager.cacheBuffer(`s${i}`, `buf-${i}`);
    }
    expect(manager.getCachedBuffer("s1")).toBeNull();
    for (let i = 2; i <= 9; i += 1) {
      expect(manager.getCachedBuffer(`s${i}`)).toBe(`buf-${i}`);
    }
  });
});

describe("AttachManager detachActive and releaseSession", () => {
  it("detachActive detaches, disposes, and clears the active session", () => {
    const { manager, created } = createManager();
    manager.attach("alpha", recordingEvents().events);
    manager.detachActive();
    expect(created[0]?.detached).toBe(1);
    expect(created[0]?.disposedCount).toBe(1);
    expect(manager.activeSessionName).toBeNull();
    manager.detachActive();
    expect(created[0]?.detached).toBe(1);
  });

  it("releaseSession drops the cache and detaches when active", () => {
    const { manager, created } = createManager();
    manager.attach("alpha", recordingEvents().events);
    manager.cacheBuffer("alpha", "buf");
    manager.releaseSession("alpha");
    expect(manager.getCachedBuffer("alpha")).toBeNull();
    expect(created[0]?.detached).toBe(1);
    expect(created[0]?.disposedCount).toBe(1);
    expect(manager.activeSessionName).toBeNull();
  });

  it("releaseSession of an inactive session leaves the active attachment alone", () => {
    const { manager, created } = createManager();
    manager.attach("alpha", recordingEvents().events);
    manager.cacheBuffer("beta", "buf-b");
    manager.releaseSession("beta");
    expect(manager.getCachedBuffer("beta")).toBeNull();
    expect(created[0]?.detached).toBe(0);
    expect(manager.activeSessionName).toBe("alpha");
  });
});

describe("AttachManager dispose", () => {
  it("disposes the active socket, clears the cache, and drops stale events", () => {
    const { manager, created } = createManager();
    const recorder = recordingEvents();
    manager.attach("alpha", recorder.events);
    manager.cacheBuffer("beta", "buf-b");
    manager.dispose();

    expect(created[0]?.detached).toBe(1);
    expect(created[0]?.disposedCount).toBe(1);
    expect(manager.activeSessionName).toBeNull();
    expect(manager.getCachedBuffer("beta")).toBeNull();

    created[0]?.events.onOutput("stale", 1);
    expect(recorder.calls.outputs).toHaveLength(0);
  });

  it("rejects attach after dispose", () => {
    const { manager } = createManager();
    manager.dispose();
    expect(() => manager.attach("alpha", recordingEvents().events)).toThrow(/disposed/);
  });
});

// The Terminal window keeps its recent tabs attached (spec 2701 layer 6).
describe("AttachManager with several live attachments", () => {
  it("keeps up to maxLive sessions attached, each receiving its own output", () => {
    const { manager, created } = createManager(undefined, 3);
    const views = ["a", "b", "c"].map((name) => ({ name, ...recordingEvents() }));
    const attachments = views.map((view) => manager.attach(view.name, view.events));
    expect(created.map((socket) => socket.detached)).toEqual([0, 0, 0]);
    expect(manager.liveSessionNames).toEqual(["a", "b", "c"]);
    created[0]!.events.onOutput("to a", 1);
    created[2]!.events.onOutput("to c", 1);
    expect(views.map((view) => view.calls.outputs.map((output) => output.data))).toEqual([["to a"], [], ["to c"]]);
    attachments[1]!.write("typed in b");
    expect(created[1]!.inputs).toEqual(["typed in b"]);
  });

  it("evicts the least recently attached past the limit and tells its view", () => {
    const { manager, created } = createManager(undefined, 2);
    const a = recordingEvents();
    const first = manager.attach("a", a.events);
    manager.attach("b", recordingEvents().events);
    manager.attach("a", recordingEvents().events); // a again: now the most recent
    expect(created[0]!.detached).toBe(1); // the old socket of a was replaced
    expect(first.live()).toBe(false);
    const c = manager.attach("c", recordingEvents().events);
    expect(created[1]!.detached).toBe(1); // b, the least recent, is out
    expect(manager.liveSessionNames).toEqual(["a", "c"]);
    expect(c.live()).toBe(true);
  });

  it("tells an evicted view it no longer follows its terminal", () => {
    const { manager, created } = createManager(undefined, 2);
    const a = recordingEvents();
    manager.attach("a", a.events);
    manager.attach("b", recordingEvents().events);
    manager.attach("c", recordingEvents().events);
    expect(a.calls.states).toEqual(["connection-lost"]);
    // Late events of the evicted socket do not reach the view.
    created[0]!.events.onOutput("late", 9);
    expect(a.calls.outputs).toEqual([]);
  });

  it("releases only the attachment that asks, never a newer one of the same session", () => {
    const { manager, created } = createManager(undefined, 3);
    const stale = manager.attach("a", recordingEvents().events);
    manager.attach("b", recordingEvents().events);
    const fresh = manager.attach("a", recordingEvents().events);
    stale.release();
    expect(created[2]!.detached).toBe(0);
    expect(manager.liveSessionNames).toEqual(["b", "a"]);
    fresh.release();
    expect(created[2]!.detached).toBe(1);
    expect(manager.liveSessionNames).toEqual(["b"]);
  });

  it("caps maxLive at the attachment budget", () => {
    const { manager, created } = createManager(undefined, 50);
    for (let index = 0; index < 10; index += 1) manager.attach(`s${index}`, recordingEvents().events);
    expect(manager.liveSessionNames).toHaveLength(8);
    expect(created.filter((socket) => socket.detached > 0)).toHaveLength(2);
  });
});
