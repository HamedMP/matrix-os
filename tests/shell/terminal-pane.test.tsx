import { describe, expect, it } from "vitest";
import { getCachedTerminalRestorePlan } from "../../shell/src/components/terminal/terminal-restore.js";
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
});
