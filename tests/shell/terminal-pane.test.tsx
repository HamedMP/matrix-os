import { describe, expect, it, vi } from "vitest";
import {
  discardStaleCachedTerminal,
  getCachedTerminalRestorePlan,
} from "../../shell/src/components/terminal/terminal-restore.js";
import type { CachedTerminal } from "../../shell/src/components/terminal/terminal-cache.js";

describe("getCachedTerminalRestorePlan", () => {
  it("keeps the session id but does not reuse terminal DOM when the cached socket is stale", () => {
    const cached = {
      terminal: { element: {} as HTMLElement } as CachedTerminal["terminal"],
      fitAddon: {} as CachedTerminal["fitAddon"],
      webglAddon: null,
      searchAddon: null,
      ws: { readyState: 3 } as WebSocket,
      lastSeq: 42,
      sessionId: "session-123",
    } satisfies CachedTerminal;

    const plan = getCachedTerminalRestorePlan(cached);

    expect(plan.reuseTerminal).toBe(false);
    expect(plan.reuseSocket).toBe(false);
    expect(plan.sessionId).toBe("session-123");
    expect(plan.lastSeq).toBe(0);
  });

  it("closes and disposes a stale cached terminal before reconnecting", () => {
    const close = vi.fn();
    const dispose = vi.fn();
    const cached = {
      terminal: { dispose } as unknown as CachedTerminal["terminal"],
      fitAddon: {} as CachedTerminal["fitAddon"],
      webglAddon: null,
      searchAddon: null,
      ws: {
        readyState: WebSocket.CLOSING,
        close,
      } as unknown as WebSocket,
      lastSeq: 7,
      sessionId: "session-456",
    } satisfies CachedTerminal;

    discardStaleCachedTerminal(cached);

    expect(close).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes an already closed cached terminal without re-closing the socket", () => {
    const close = vi.fn();
    const dispose = vi.fn();
    const cached = {
      terminal: { dispose } as unknown as CachedTerminal["terminal"],
      fitAddon: {} as CachedTerminal["fitAddon"],
      webglAddon: null,
      searchAddon: null,
      ws: {
        readyState: WebSocket.CLOSED,
        close,
      } as unknown as WebSocket,
      lastSeq: 7,
      sessionId: "session-456",
    } satisfies CachedTerminal;

    discardStaleCachedTerminal(cached);

    expect(close).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
