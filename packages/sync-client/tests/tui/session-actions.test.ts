import { describe, expect, it, vi } from "vitest";
import {
  createShellSessionTuiAdapterFromClient,
  resolveSessionKeyboardIntent,
  selectedShellSession,
} from "../../src/cli/tui/sessions/session-actions.js";
import {
  attachShellSession,
  killCodingSession,
  observeCodingSession,
  takeoverCodingSession,
} from "../../src/cli/tui/session-actions.js";
import { shellSessionFixtures } from "./session-fixtures.js";

describe("shell session TUI actions", () => {
  it("delegates list, create, attach, and remove to the shell session client", async () => {
    const shell = {
      list: vi.fn(async () => shellSessionFixtures),
      create: vi.fn(async () => ({ name: "main" })),
      attach: vi.fn(async () => ({ detached: true })),
      remove: vi.fn(async () => undefined),
      listTabs: vi.fn(async () => []),
      listLayouts: vi.fn(async () => []),
      splitPane: vi.fn(async () => ({})),
      applyLayout: vi.fn(async () => ({})),
    };
    const adapter = createShellSessionTuiAdapterFromClient(shell);

    await expect(adapter.list()).resolves.toEqual(shellSessionFixtures);
    await adapter.createDefault();
    await adapter.attach("main");
    await adapter.remove("main");

    expect(shell.create).toHaveBeenCalledWith({ name: "main" });
    expect(shell.attach).toHaveBeenCalledWith("main");
    expect(shell.remove).toHaveBeenCalledWith("main", { force: false });
  });

  it("resolves keyboard intents and selected sessions", () => {
    expect(resolveSessionKeyboardIntent("", { return: true })).toBe("attach");
    expect(resolveSessionKeyboardIntent("n")).toBe("create");
    expect(resolveSessionKeyboardIntent("r")).toBe("refresh");
    expect(resolveSessionKeyboardIntent("k")).toBe("remove");
    expect(resolveSessionKeyboardIntent("", { escape: true })).toBe("close");
    expect(selectedShellSession(shellSessionFixtures, 1)?.name).toBe("review");
    expect(selectedShellSession(shellSessionFixtures, 99)).toBeUndefined();
  });
});

describe("existing session attach actions", () => {
  it("delegates shell attach and coding session controls", async () => {
    const shellClient = { attach: vi.fn(async () => ({ detached: true })) };
    const codingClient = {
      observe: vi.fn(async () => ({ attached: true as const, mode: "observe" as const })),
      takeover: vi.fn(async () => ({ attached: true as const, mode: "takeover" as const })),
      kill: vi.fn(async () => undefined),
    };

    await expect(attachShellSession(shellClient, "main")).resolves.toEqual({ returned: true });
    await expect(observeCodingSession(codingClient, "agent-1")).resolves.toEqual({ attached: true, mode: "observe" });
    await expect(takeoverCodingSession(codingClient, "agent-1")).resolves.toEqual({ attached: true, mode: "takeover" });
    await expect(killCodingSession(codingClient, "agent-1")).resolves.toEqual({ killed: true });

    expect(shellClient.attach).toHaveBeenCalledWith("main");
    expect(codingClient.kill).toHaveBeenCalledWith("agent-1");
  });
});
