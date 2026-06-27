import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReconnectAbortTimersForSession,
  drainReconnectableAbortEntries,
  replaceReconnectableAbortEntry,
  scheduleReconnectAbortTimersForDisconnectedClient,
  scheduleReconnectAbortTimersForSession,
  type ReconnectableAbortEntry,
} from "../../packages/gateway/src/conversation-reconnect-aborts.js";

describe("conversation reconnect abort guards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules abort timers for adopted reconnectable runs in the closing session", () => {
    vi.useFakeTimers();
    const adoptedAbort = vi.fn();
    const currentAbort = vi.fn();
    const entries = new Map<string, ReconnectableAbortEntry>([
      ["adopted", {
        controller: { abort: adoptedAbort },
        sessionId: "sess-1",
        abortTimer: null,
      }],
      ["current", {
        controller: { abort: currentAbort },
        sessionId: "sess-1",
        abortTimer: null,
      }],
    ]);

    scheduleReconnectAbortTimersForSession(entries, "sess-1", {
      graceMs: 1_000,
      hasActiveSessionConnection: () => false,
    });

    expect(entries.get("adopted")?.abortTimer).not.toBeNull();
    expect(entries.get("current")?.abortTimer).not.toBeNull();

    vi.advanceTimersByTime(1_000);

    expect(adoptedAbort).toHaveBeenCalledTimes(1);
    expect(currentAbort).toHaveBeenCalledTimes(1);
    expect(entries.has("adopted")).toBe(false);
    expect(entries.has("current")).toBe(false);
  });

  it("does not duplicate timers or abort sessions with another live attachment", () => {
    vi.useFakeTimers();
    const adoptedAbort = vi.fn();
    const healthyAbort = vi.fn();
    const existingTimer = setTimeout(() => {}, 10_000);
    const entries = new Map<string, ReconnectableAbortEntry>([
      ["already-scheduled", {
        controller: { abort: adoptedAbort },
        sessionId: "sess-1",
        abortTimer: existingTimer,
      }],
      ["healthy", {
        controller: { abort: healthyAbort },
        sessionId: "sess-2",
        abortTimer: null,
      }],
    ]);

    scheduleReconnectAbortTimersForSession(entries, "sess-1", {
      graceMs: 1_000,
      hasActiveSessionConnection: () => false,
    });
    scheduleReconnectAbortTimersForSession(entries, "sess-2", {
      graceMs: 1_000,
      hasActiveSessionConnection: () => true,
    });

    expect(entries.get("already-scheduled")?.abortTimer).toBe(existingTimer);
    expect(entries.get("healthy")?.abortTimer).toBeNull();

    vi.advanceTimersByTime(1_000);

    expect(adoptedAbort).not.toHaveBeenCalled();
    expect(healthyAbort).not.toHaveBeenCalled();

    clearTimeout(existingTimer);
  });

  it("clears pending reconnect abort timers when a session is reattached", () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const entries = new Map<string, ReconnectableAbortEntry>([
      ["req-1", {
        controller: { abort },
        sessionId: "sess-1",
        abortTimer: setTimeout(() => {
          abort();
        }, 1_000),
      }],
    ]);

    clearReconnectAbortTimersForSession(entries, "sess-1");
    vi.advanceTimersByTime(1_000);

    expect(abort).not.toHaveBeenCalled();
    expect(entries.get("req-1")?.abortTimer).toBeNull();
  });

  it("schedules inactive adopted runs from earlier sessions when a switched client closes", () => {
    vi.useFakeTimers();
    const inactiveAbort = vi.fn();
    const healthyAbort = vi.fn();
    const entries = new Map<string, ReconnectableAbortEntry>([
      ["req-from-sess-a", {
        controller: { abort: inactiveAbort },
        sessionId: "sess-A",
        abortTimer: null,
      }],
      ["req-from-sess-b", {
        controller: { abort: healthyAbort },
        sessionId: "sess-B",
        abortTimer: null,
      }],
    ]);

    scheduleReconnectAbortTimersForDisconnectedClient(entries, {
      graceMs: 1_000,
      hasActiveSessionConnection: (sessionId) => sessionId === "sess-B",
    });

    expect(entries.get("req-from-sess-a")?.abortTimer).not.toBeNull();
    expect(entries.get("req-from-sess-b")?.abortTimer).toBeNull();

    vi.advanceTimersByTime(1_000);

    expect(inactiveAbort).toHaveBeenCalledTimes(1);
    expect(healthyAbort).not.toHaveBeenCalled();
    expect(entries.has("req-from-sess-a")).toBe(false);
    expect(entries.has("req-from-sess-b")).toBe(true);
  });

  it("cancels a stale reconnect timer before replacing a reused request id", () => {
    vi.useFakeTimers();
    const staleAbort = vi.fn();
    const liveAbort = vi.fn();
    const entries = new Map<string, ReconnectableAbortEntry>([
      ["req-1", {
        controller: { abort: staleAbort },
        sessionId: "sess-1",
        abortTimer: null,
      }],
    ]);

    scheduleReconnectAbortTimersForSession(entries, "sess-1", {
      graceMs: 30_000,
      hasActiveSessionConnection: () => false,
    });
    const staleTimer = entries.get("req-1")?.abortTimer;
    expect(staleTimer).not.toBeNull();

    replaceReconnectableAbortEntry(entries, "req-1", {
      controller: { abort: liveAbort },
      sessionId: "sess-1",
      abortTimer: null,
    });

    vi.advanceTimersByTime(30_000);

    expect(staleAbort).not.toHaveBeenCalled();
    expect(liveAbort).not.toHaveBeenCalled();
    expect(entries.get("req-1")?.controller.abort).toBe(liveAbort);

    scheduleReconnectAbortTimersForSession(entries, "sess-1", {
      graceMs: 30_000,
      hasActiveSessionConnection: () => false,
    });
    expect(entries.get("req-1")?.abortTimer).not.toBeNull();

    vi.advanceTimersByTime(30_000);

    expect(liveAbort).toHaveBeenCalledTimes(1);
    expect(entries.has("req-1")).toBe(false);
  });

  it("evicts and aborts oldest reconnectable entries when the map reaches its cap", () => {
    vi.useFakeTimers();
    const oldestAbort = vi.fn();
    const newestAbort = vi.fn();
    const entries = new Map<string, ReconnectableAbortEntry>([
      ["oldest", {
        controller: { abort: oldestAbort },
        sessionId: "sess-old",
        abortTimer: setTimeout(() => {
          oldestAbort();
        }, 30_000),
      }],
    ]);

    replaceReconnectableAbortEntry(entries, "newest", {
      controller: { abort: newestAbort },
      sessionId: "sess-new",
      abortTimer: null,
    }, { maxEntries: 1 });
    vi.advanceTimersByTime(30_000);

    expect(oldestAbort).toHaveBeenCalledTimes(1);
    expect(newestAbort).not.toHaveBeenCalled();
    expect(entries.has("oldest")).toBe(false);
    expect(entries.has("newest")).toBe(true);
  });

  it("drains reconnect abort entries on shutdown", () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const entries = new Map<string, ReconnectableAbortEntry>([
      ["req-1", {
        controller: { abort },
        sessionId: "sess-1",
        abortTimer: setTimeout(() => {
          abort();
        }, 30_000),
      }],
    ]);

    drainReconnectableAbortEntries(entries);
    vi.advanceTimersByTime(30_000);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(entries.size).toBe(0);
  });
});
