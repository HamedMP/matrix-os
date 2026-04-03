import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cacheTerminal,
  getCached,
  removeCached,
  hasCached,
  type CachedTerminal,
} from "../../shell/src/components/terminal/terminal-cache.js";

function createMockCachedTerminal(overrides: Partial<CachedTerminal> = {}): CachedTerminal {
  return {
    terminal: { dispose: vi.fn() } as unknown as CachedTerminal["terminal"],
    fitAddon: {} as CachedTerminal["fitAddon"],
    webglAddon: null,
    searchAddon: null,
    ws: { send: vi.fn(), close: vi.fn() } as unknown as WebSocket,
    lastSeq: 0,
    sessionId: "test-session-id",
    ...overrides,
  };
}

describe("Terminal Cache", () => {
  beforeEach(() => {
    for (let i = 1; i <= 25; i++) {
      removeCached(`pane-${i}`);
    }
  });

  it("cacheTerminal stores an entry and getCached retrieves it", () => {
    const entry = createMockCachedTerminal({ sessionId: "session-abc" });
    cacheTerminal("pane-1", entry);

    const cached = getCached("pane-1");
    expect(cached).not.toBeNull();
    expect(cached!.sessionId).toBe("session-abc");
  });

  it("getCached returns null for cache miss", () => {
    expect(getCached("nonexistent")).toBeNull();
  });

  it("hasCached returns true for cached pane", () => {
    cacheTerminal("pane-1", createMockCachedTerminal());
    expect(hasCached("pane-1")).toBe(true);
  });

  it("hasCached returns false for uncached pane", () => {
    expect(hasCached("nonexistent")).toBe(false);
  });

  it("removeCached deletes the entry", () => {
    cacheTerminal("pane-1", createMockCachedTerminal());
    expect(hasCached("pane-1")).toBe(true);

    removeCached("pane-1");
    expect(hasCached("pane-1")).toBe(false);
    expect(getCached("pane-1")).toBeNull();
  });

  it("removeCached is a no-op for nonexistent key", () => {
    removeCached("nonexistent"); // should not throw
    expect(hasCached("nonexistent")).toBe(false);
  });

  it("cacheTerminal overwrites existing entry for same paneId", () => {
    const entry1 = createMockCachedTerminal({ sessionId: "session-1" });
    const entry2 = createMockCachedTerminal({ sessionId: "session-2" });

    cacheTerminal("pane-1", entry1);
    cacheTerminal("pane-1", entry2);

    const cached = getCached("pane-1");
    expect(cached!.sessionId).toBe("session-2");
  });

  it("supports multiple panes cached simultaneously", () => {
    cacheTerminal("pane-1", createMockCachedTerminal({ sessionId: "s1" }));
    cacheTerminal("pane-2", createMockCachedTerminal({ sessionId: "s2" }));
    cacheTerminal("pane-3", createMockCachedTerminal({ sessionId: "s3" }));

    expect(getCached("pane-1")!.sessionId).toBe("s1");
    expect(getCached("pane-2")!.sessionId).toBe("s2");
    expect(getCached("pane-3")!.sessionId).toBe("s3");
  });

  it("preserves lastSeq value", () => {
    cacheTerminal("pane-1", createMockCachedTerminal({ lastSeq: 42 }));
    expect(getCached("pane-1")!.lastSeq).toBe(42);
  });

  it("evicts the oldest entry before exceeding the hard cap", () => {
    const evicted = createMockCachedTerminal();

    for (let i = 1; i <= 20; i++) {
      cacheTerminal(`pane-${i}`, i === 1 ? evicted : createMockCachedTerminal({ sessionId: `session-${i}` }));
    }

    cacheTerminal("pane-21", createMockCachedTerminal({ sessionId: "session-21" }));

    expect(hasCached("pane-1")).toBe(false);
    expect((evicted.ws as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(JSON.stringify({ type: "detach" }));
    expect((evicted.ws as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
    expect((evicted.terminal as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledOnce();
    expect(hasCached("pane-21")).toBe(true);
  });
});
