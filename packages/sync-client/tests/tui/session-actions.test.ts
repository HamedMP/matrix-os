import { describe, expect, it, vi } from "vitest";
import { attachShellSession, killCodingSession, observeCodingSession, takeoverCodingSession } from "../../src/cli/tui/session-actions.js";

describe("session actions", () => {
  it("attaches to shell sessions through the shell client and returns to the TUI", async () => {
    const shellClient = { attach: vi.fn(async () => ({ detached: true })) };

    await expect(attachShellSession(shellClient, "main")).resolves.toEqual({ returned: true });
    expect(shellClient.attach).toHaveBeenCalledWith("main");
  });

  it("observes, takes over, and kills coding sessions through the coding client", async () => {
    const codingClient = {
      observe: vi.fn(async () => ({ mode: "observe", terminalSessionId: "term_1" })),
      takeover: vi.fn(async () => ({ mode: "owner", terminalSessionId: "term_2" })),
      kill: vi.fn(async () => ({ id: "sess_abc123" })),
    };

    await expect(observeCodingSession(codingClient, "sess_abc123")).resolves.toMatchObject({ mode: "observe", terminalSessionId: "term_1" });
    await expect(takeoverCodingSession(codingClient, "sess_abc123")).resolves.toMatchObject({ mode: "owner", terminalSessionId: "term_2" });
    await expect(killCodingSession(codingClient, "sess_abc123")).resolves.toEqual({ killed: true });
  });
});
