import { describe, expect, it, vi } from "vitest";
import {
  ZellijCliRuntimeAdapter,
  type RuntimePty,
  type RuntimeSubscriptionProcess,
} from "../../packages/terminal-runtime/src/zellij-adapter.js";

describe("Zellij 0.44.3 structured runtime adapter", () => {
  it("skips rollback cleanup for workspace sessions that were never created", async () => {
    const existingSession = "matrix-w-0123456789abcdef0123456789abcdef";
    const missingSession = "matrix-w-fedcba9876543210fedcba9876543210";
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("list-sessions")) return `${existingSession} [Created 1s ago]\n`;
      if (args.includes(missingSession)) throw new Error("session not found");
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.stopWorkspaceSessions([missingSession, existingSession])).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(["delete-session", existingSession, "--force"]);
    expect(run).not.toHaveBeenCalledWith(["delete-session", missingSession, "--force"]);
  });

  it("propagates session enumeration failures during rollback cleanup", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("list-sessions")) throw new Error("transient list failure");
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.stopWorkspaceSessions([
      "matrix-w-0123456789abcdef0123456789abcdef",
    ])).rejects.toThrow("transient list failure");
  });

  it("treats Zellij's no-active-sessions response as an empty live set", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("list-sessions")) {
        throw Object.assign(new Error("zellij exited"), {
          stderr: "NO ACTIVE ZELLIJ SESSIONS FOUND\n",
        });
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.stopWorkspaceSessions([
      "matrix-w-0123456789abcdef0123456789abcdef",
    ])).resolves.toBeUndefined();
  });

  it("discovers the structured tab ID when new-tab returns empty stdout", async () => {
    const internalName = "matrix-tab-0123456789abcdef0123456789abcdef";
    let tabReads = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("new-tab")) return "";
      if (args.includes("list-tabs")) {
        tabReads += 1;
        return JSON.stringify(tabReads === 1 ? [] : [{ tab_id: 7, name: internalName }]);
      }
      if (args.includes("list-panes")) {
        return JSON.stringify([{ id: 12, is_plugin: false, tab_id: 7 }]);
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.createTab("matrix-w-0123456789abcdef0123456789abcdef", {
      internalName,
      cwd: "projects/matrix-os",
    })).resolves.toEqual({ tabId: 7, paneId: "terminal_12" });
    expect(tabReads).toBe(2);
  });

  it("keeps polling for a delayed tab ID during dense workspace startup", async () => {
    const internalName = "matrix-tab-0123456789abcdef0123456789abcdef";
    let tabReads = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("new-tab")) return "";
      if (args.includes("list-tabs")) {
        tabReads += 1;
        return JSON.stringify(tabReads <= 11 ? [] : [{ tab_id: 7, name: internalName }]);
      }
      if (args.includes("list-panes")) {
        return JSON.stringify([{ id: 12, is_plugin: false, tab_id: 7 }]);
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.createTab("matrix-w-0123456789abcdef0123456789abcdef", {
      internalName,
      cwd: "projects/matrix-os",
    })).resolves.toEqual({ tabId: 7, paneId: "terminal_12" });
    expect(tabReads).toBe(12);
  });

  it("keeps polling for a delayed pane ID during dense workspace startup", async () => {
    let paneReads = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("new-tab")) return "7\n";
      if (args.includes("list-tabs")) return "[]";
      if (args.includes("list-panes")) {
        paneReads += 1;
        return JSON.stringify(paneReads <= 10 ? [] : [{ id: 12, is_plugin: false, tab_id: 7 }]);
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.createTab("matrix-w-0123456789abcdef0123456789abcdef", {
      internalName: "matrix-tab-0123456789abcdef0123456789abcdef",
      cwd: "projects/matrix-os",
    })).resolves.toEqual({ tabId: 7, paneId: "terminal_12" });
    expect(paneReads).toBe(11);
  });

  it("uses returned tab IDs, structured pane IDs, targeted input, and subscribe output", async () => {
    const commands: string[][] = [];
    let paneReads = 0;
    const run = vi.fn(async (args: string[]) => {
      commands.push(args);
      if (args.includes("new-tab")) return "7\n";
      if (args.includes("list-tabs")) return "[]";
      if (args.includes("list-panes")) {
        paneReads += 1;
        return JSON.stringify(paneReads === 1 ? [] : [
          { id: 12, is_plugin: false, tab_id: 7, pane_cwd: "/home/matrix/projects/matrix-os" },
        ]);
      }
      if (args.includes("dump-screen")) return "history\nready$ ";
      return "";
    });
    const pty: RuntimePty = {
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    };
    let emitSubscription = (_line: string) => undefined;
    const subscription: RuntimeSubscriptionProcess = {
      close: vi.fn(async () => undefined),
    };
    const spawnSubscription = vi.fn((_args: string[], onLine: (line: string) => void) => {
      emitSubscription = onLine;
      return subscription;
    });
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix",
      run,
      spawnPty: vi.fn(() => pty),
      spawnSubscription,
    });

    const created = await adapter.createTab("matrix-w-0123456789abcdef0123456789abcdef", {
      internalName: "matrix-tab-0123456789abcdef0123456789abcdef",
      cwd: "projects/matrix-os",
      command: ["sh", "-lc", "pnpm test"],
    });
    expect(created).toEqual({ tabId: 7, paneId: "terminal_12" });
    expect(paneReads).toBe(2);
    expect(commands).toContainEqual([
      "--session", "matrix-w-0123456789abcdef0123456789abcdef",
      "action", "new-tab", "--name", "matrix-tab-0123456789abcdef0123456789abcdef",
      "--cwd", "/home/matrix/projects/matrix-os", "--", "sh", "-lc", "pnpm test",
    ]);

    const attachment = await adapter.openAttachment("matrix-w-0123456789abcdef0123456789abcdef", {
      paneId: created.paneId,
      size: { cols: 120, rows: 36 },
      onData: () => undefined,
      onExit: () => undefined,
    });
    await attachment.write(new TextEncoder().encode("echo hi\r"));
    expect(commands).toContainEqual([
      "--session", "matrix-w-0123456789abcdef0123456789abcdef",
      "action", "write-chars", "--pane-id", "terminal_12", "--", "echo hi\r",
    ]);

    const events: unknown[] = [];
    await adapter.subscribeWorkspace("matrix-w-0123456789abcdef0123456789abcdef", {
      paneIds: ["terminal_12", "terminal_13"],
      onEvent: (event) => { events.push(event); },
    });
    expect(spawnSubscription).toHaveBeenCalledWith([
      "--session", "matrix-w-0123456789abcdef0123456789abcdef", "subscribe",
      "--pane-id", "terminal_12", "terminal_13", "--format", "json", "--ansi", "--scrollback",
    ], expect.any(Function), expect.any(Function));
    emitSubscription(JSON.stringify({
      event: "pane_update",
      pane_id: "terminal_12",
      viewport: ["ready$ "],
      scrollback: ["history"],
      is_initial: true,
    }));
    emitSubscription(JSON.stringify({
      event: "pane_update",
      pane_id: "terminal_12",
      viewport: ["updated$ "],
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([{
      type: "pane-update",
      paneId: "terminal_12",
      ansi: "history\nready$ ",
      viewport: ["ready$ "],
      scrollback: ["history"],
    }, {
      type: "pane-update",
      paneId: "terminal_12",
      ansi: "history\nready$ ",
      viewport: ["updated$ "],
      scrollback: ["history"],
    }]);
  });
});
