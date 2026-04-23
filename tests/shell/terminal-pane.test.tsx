import { describe, expect, it, vi } from "vitest";
import {
  closeStaleCachedSocket,
  getCachedTerminalRestorePlan,
} from "../../shell/src/components/terminal/terminal-restore.js";
import type { CachedTerminal } from "../../shell/src/components/terminal/terminal-cache.js";

describe("getCachedTerminalRestorePlan", () => {
  it("preserves cached session state even when the cached socket can no longer be reused", () => {
    const cached = {
      terminal: {} as CachedTerminal["terminal"],
      fitAddon: {} as CachedTerminal["fitAddon"],
      webglAddon: null,
      searchAddon: null,
      ws: { readyState: 3 } as WebSocket,
      lastSeq: 42,
      sessionId: "session-123",
    } satisfies CachedTerminal;

    const plan = getCachedTerminalRestorePlan(cached);

    expect(plan.reuseTerminal).toBe(true);
    expect(plan.reuseSocket).toBe(false);
    expect(plan.sessionId).toBe("session-123");
    expect(plan.lastSeq).toBe(42);
  });

  it("closes a stale cached socket before reconnecting", () => {
    const close = vi.fn();
    const cached = {
      terminal: {} as CachedTerminal["terminal"],
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

    closeStaleCachedSocket(cached);

    expect(close).toHaveBeenCalledOnce();
  });

  it("does not re-close an already closed cached socket", () => {
    const close = vi.fn();
    const cached = {
      terminal: {} as CachedTerminal["terminal"],
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

    closeStaleCachedSocket(cached);

    expect(close).not.toHaveBeenCalled();
  });
});
