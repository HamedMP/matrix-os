import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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

  it("reuses terminal DOM and replay position when a cached canonical shell socket was detached", () => {
    const cached = {
      terminal: { element: {} as HTMLElement } as CachedTerminal["terminal"],
      fitAddon: {} as CachedTerminal["fitAddon"],
      webglAddon: null,
      searchAddon: null,
      ws: { readyState: WebSocket.CLOSED } as WebSocket,
      lastSeq: 42,
      sessionId: "main",
      socketRetained: false,
    } satisfies CachedTerminal;

    const plan = getCachedTerminalRestorePlan(cached);

    expect(plan.reuseTerminal).toBe(true);
    expect(plan.reuseSocket).toBe(false);
    expect(plan.sessionId).toBe("main");
    expect(plan.lastSeq).toBe(42);
  });

  it("preserves an explicit zero replay cursor when a cached shell was detached", () => {
    const cached = {
      terminal: { element: {} as HTMLElement } as CachedTerminal["terminal"],
      fitAddon: {} as CachedTerminal["fitAddon"],
      webglAddon: null,
      searchAddon: null,
      ws: { readyState: WebSocket.CLOSED } as WebSocket,
      lastSeq: 0,
      hasReplayCursor: true,
      sessionId: "main",
      socketRetained: false,
    } satisfies CachedTerminal;

    const plan = getCachedTerminalRestorePlan(cached);

    expect(plan.reuseTerminal).toBe(true);
    expect(plan.reuseSocket).toBe(false);
    expect(plan.sessionId).toBe("main");
    expect(plan.lastSeq).toBe(0);
    expect(plan.hasReplayCursor).toBe(true);
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

describe("TerminalPane terminal-link wiring", () => {
  const source = readFileSync("shell/src/components/terminal/TerminalPane.tsx", "utf8");

  it("uses the bounded reducer and both approved link action surfaces", () => {
    expect(source).toContain("useReducer(");
    expect(source).toContain("terminalLinksReducer");
    expect(source).toContain("scanTerminalLinkOutput");
    expect(source).toContain("<TerminalLinksTray");
    expect(source).toContain("<TerminalLinkContextMenu");
    expect(source).not.toContain("TerminalAuthBanner");
    expect(source).not.toContain("authLink");
  });

  it("intercepts contextmenu only after resolving a safe link under the pointer", () => {
    expect(source).toContain('addEventListener("contextmenu"');
    expect(source).toContain("terminalCellFromPointer");
    expect(source).toContain("findTerminalLinkAtCell");
    expect(source).toMatch(/if \(!(?:cell|link)\) return;/);
    expect(source).toContain("event.preventDefault()");
  });

  it("overrides xterm OSC hyperlink activation with the button-aware link handler", () => {
    expect(source).toContain("linkHandler: { activate: activateTerminalLink }");
  });
});
