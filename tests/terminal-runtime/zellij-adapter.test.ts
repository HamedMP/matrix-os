import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ZellijCliRuntimeAdapter,
  type RuntimePty,
  type RuntimeSubscriptionProcess,
} from "../../packages/terminal-runtime/src/zellij-adapter.js";

const lexicalRealpath = async (path: string): Promise<string> => path;

describe("Zellij 0.44.3 structured runtime adapter", () => {
  it("propagates one explicit owner runtime environment to attachments", async () => {
    const runtimeEnvironment = {
      HOME: "/home/matrix/home",
      MATRIX_HOME: "/home/matrix/home",
      ZELLIJ_CONFIG_DIR: "/home/matrix/home/system/zellij",
      XDG_RUNTIME_DIR: "/run/user/999",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/999/bus",
    };
    const spawnPty = vi.fn((): RuntimePty => ({
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    }));
    const run = vi.fn(async () => "");
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix/home",
      env: runtimeEnvironment,
      run,
      spawnPty,
    });

    await adapter.openAttachment("matrix-w-0123456789abcdef0123456789abcdef", {
      paneId: "terminal_12",
      size: { cols: 120, rows: 36 },
      onData: () => undefined,
      onExit: () => undefined,
    });

    expect(spawnPty).toHaveBeenCalledWith(
      ["attach", "matrix-w-0123456789abcdef0123456789abcdef"],
      expect.objectContaining({ env: runtimeEnvironment }),
    );
  });

  it("propagates non-missing legacy session deletion failures", async () => {
    const failure = Object.assign(new Error("denied"), { stderr: "permission denied" });
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix/home",
      run: vi.fn(async () => { throw failure; }),
    });

    await expect(adapter.stopLegacySessions(["legacy-session"]))
      .rejects.toBe(failure);
  });

  it("tolerates only confirmed missing legacy sessions", async () => {
    const failure = Object.assign(new Error("missing"), { stderr: "session does not exist" });
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix/home",
      run: vi.fn(async () => { throw failure; }),
    });

    await expect(adapter.stopLegacySessions(["legacy-session"]))
      .resolves.toBeUndefined();
  });

  it.each([
    [{ type: "resize", direction: "up" }, ["resize", "increase", "up", "--pane-id", "terminal_12"]],
    [{ type: "fullscreen" }, ["toggle-fullscreen", "--pane-id", "terminal_12"]],
    [{ type: "scroll", edge: "top" }, ["scroll-to-top", "--pane-id", "terminal_12"]],
    [{ type: "close" }, ["close-pane", "--pane-id", "terminal_12"]],
  ] as const)("targets workspace pane action %j", async (action, args) => {
    const run = vi.fn(async () => "");
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await adapter.paneAction(
      "matrix-w-0123456789abcdef0123456789abcdef",
      7,
      "terminal_12",
      action,
    );

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith([
      "--session", "matrix-w-0123456789abcdef0123456789abcdef",
      "action", ...args,
    ]);
  });

  it("creates a split in the stable tab without a focus-switch precommand", async () => {
    const run = vi.fn(async () => "terminal_13\n");
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await adapter.paneAction(
      "matrix-w-0123456789abcdef0123456789abcdef",
      7,
      "terminal_12",
      { type: "split", direction: "right" },
    );

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith([
      "--session", "matrix-w-0123456789abcdef0123456789abcdef",
      "action", "new-pane", "--direction", "right", "--tab-id", "7",
    ]);
  });

  it("resolves focus movement from the stable pane geometry and focuses the resulting pane by ID", async () => {
    const run = vi.fn(async (args: string[]) => args.includes("list-panes")
      ? JSON.stringify([
          { id: 12, is_plugin: false, tab_id: 7, pane_x: 0, pane_y: 0, pane_rows: 40, pane_columns: 60 },
          { id: 13, is_plugin: false, tab_id: 7, pane_x: 60, pane_y: 0, pane_rows: 20, pane_columns: 60 },
          { id: 14, is_plugin: false, tab_id: 7, pane_x: 60, pane_y: 20, pane_rows: 20, pane_columns: 60 },
          { id: 15, is_plugin: false, tab_id: 8, pane_x: 120, pane_y: 0, pane_rows: 40, pane_columns: 60 },
        ])
      : "");
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await adapter.paneAction(
      "matrix-w-0123456789abcdef0123456789abcdef",
      7,
      "terminal_12",
      { type: "focus", direction: "right" },
    );

    expect(run).toHaveBeenNthCalledWith(1, [
      "--session", "matrix-w-0123456789abcdef0123456789abcdef",
      "action", "list-panes", "--all", "--json",
    ]);
    expect(run).toHaveBeenNthCalledWith(2, [
      "--session", "matrix-w-0123456789abcdef0123456789abcdef",
      "action", "focus-pane-id", "terminal_13",
    ]);
  });

  it("recovers the named primary pane after a managed tab is split", async () => {
    const internalName = "matrix-tab-0123456789abcdef0123456789abcdef";
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("list-tabs")) {
        return JSON.stringify([{ tab_id: 7, name: internalName }]);
      }
      if (args.includes("list-panes")) {
        return JSON.stringify([
          { id: 12, is_plugin: false, tab_id: 7, pane_title: internalName },
          { id: 13, is_plugin: false, tab_id: 7, pane_title: "shell" },
        ]);
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.findTabByInternalName(
      "matrix-w-0123456789abcdef0123456789abcdef",
      internalName,
    )).resolves.toEqual({ tabId: 7, paneId: "terminal_12" });
  });

  it("promotes a remaining pane through the pinned generation when the primary closes", async () => {
    const logicalName = "matrix-w-0123456789abcdef0123456789abcdef";
    const ownedName = "matrix-rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const internalName = "matrix-tab-0123456789abcdef0123456789abcdef";
    const binaryPath = `/opt/matrix/terminal-runtime/generations/gen_${"b".repeat(64)}/zellij`;
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("list-tabs")) return JSON.stringify([{ tab_id: 7, name: internalName }]);
      if (args.includes("list-panes")) {
        return JSON.stringify([
          { id: 14, is_plugin: false, tab_id: 7, pane_title: "later" },
          { id: 13, is_plugin: false, tab_id: 7, pane_title: "shell" },
        ]);
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix",
      run,
      workspaceLifecycle: {
        resolveWorkspaceTarget: vi.fn(async () => ({ sessionName: ownedName, binaryPath })),
        ensureWorkspaceSession: vi.fn(),
        deleteWorkspaceSession: vi.fn(),
      },
    });

    await expect(adapter.findTabByInternalName(logicalName, internalName))
      .resolves.toEqual({ tabId: 7, paneId: "terminal_13" });
    expect(run).toHaveBeenLastCalledWith([
      "--session", ownedName, "action", "rename-pane", "--pane-id", "terminal_13", internalName,
    ], binaryPath);
  });

  it("routes every workspace operation through its systemd-owned Zellij session", async () => {
    const logicalName = "matrix-w-0123456789abcdef0123456789abcdef";
    const ownedName = "matrix-rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const binaryPath = `/opt/matrix/terminal-runtime/generations/gen_${"b".repeat(64)}/zellij`;
    const lifecycle = {
      resolveWorkspaceTarget: vi.fn(async () => ({ sessionName: ownedName, binaryPath })),
      ensureWorkspaceSession: vi.fn(async () => ({ sessionName: ownedName, binaryPath })),
      deleteWorkspaceSession: vi.fn(async () => undefined),
    };
    const run = vi.fn(async (args: string[], _binaryPath?: string) => {
      if (args.includes("new-tab")) return "7\n";
      if (args.includes("list-tabs")) return "[]";
      if (args.includes("list-panes")) return JSON.stringify([{ id: 12, is_plugin: false, tab_id: 7 }]);
      return "";
    });
    const pty: RuntimePty = {
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const spawnPty = vi.fn(() => pty);
    const subscription: RuntimeSubscriptionProcess = { close: vi.fn(async () => undefined) };
    const spawnSubscription = vi.fn(() => subscription);
    const adapter = new ZellijCliRuntimeAdapter({
      homePath: "/home/matrix",
      run,
      resolveRealpath: lexicalRealpath,
      spawnPty,
      spawnSubscription,
      workspaceLifecycle: lifecycle,
    });

    await adapter.ensureSession(logicalName, { cols: 120, rows: 36 });
    const created = await adapter.createTab(logicalName, {
      internalName: "matrix-tab-0123456789abcdef0123456789abcdef",
      cwd: "projects/matrix-os",
    });
    const attachment = await adapter.openAttachment(logicalName, {
      paneId: created.paneId,
      size: { cols: 120, rows: 36 },
      onData: () => undefined,
      onExit: () => undefined,
    });
    await attachment.write(new TextEncoder().encode("echo pinned\r"));
    await adapter.subscribeWorkspace(logicalName, {
      paneIds: [created.paneId],
      onEvent: () => undefined,
    });
    await adapter.paneAction(logicalName, created.tabId, created.paneId, { type: "fullscreen" });
    await adapter.deleteSession(logicalName);

    expect(lifecycle.ensureWorkspaceSession).toHaveBeenCalledWith(logicalName, { cols: 120, rows: 36 });
    expect(run.mock.calls.every(([args]) => !args.includes(logicalName))).toBe(true);
    expect(run.mock.calls.some(([args]) => args.includes(ownedName))).toBe(true);
    expect(run.mock.calls.every(([, selectedBinary]) => selectedBinary === binaryPath)).toBe(true);
    expect(spawnPty).toHaveBeenCalledWith(
      ["attach", ownedName],
      expect.objectContaining({ binaryPath }),
    );
    expect(spawnSubscription).toHaveBeenCalledWith(
      expect.arrayContaining(["--session", ownedName, "subscribe"]),
      expect.any(Function),
      expect.any(Function),
      binaryPath,
    );
    expect(lifecycle.deleteWorkspaceSession).toHaveBeenCalledWith(logicalName);
  });

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

  it("treats a session that exits between rollback inventory and deletion as already stopped", async () => {
    const sessionName = "matrix-w-0123456789abcdef0123456789abcdef";
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("list-sessions")) return `${sessionName} [Created 1s ago]\n`;
      if (args.includes("delete-session")) {
        throw Object.assign(new Error("zellij exited"), {
          stderr: "No active Zellij sessions found.",
        });
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.stopWorkspaceSessions([sessionName])).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(["delete-session", sessionName, "--force"]);
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

  it("ignores exited sessions during rollback cleanup", async () => {
    const exitedSession = "matrix-w-0123456789abcdef0123456789abcdef";
    const runningSession = "matrix-w-fedcba9876543210fedcba9876543210";
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("list-sessions")) {
        return `${exitedSession} [EXITED - Exit status: 0]\n${runningSession} [Created 1s ago]\n`;
      }
      return "";
    });
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run });

    await expect(adapter.stopWorkspaceSessions([
      exitedSession,
      runningSession,
    ])).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalledWith(["delete-session", exitedSession, "--force"]);
    expect(run).toHaveBeenCalledWith(["delete-session", runningSession, "--force"]);
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
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run, resolveRealpath: lexicalRealpath });

    await expect(adapter.createTab("matrix-w-0123456789abcdef0123456789abcdef", {
      internalName,
      cwd: "projects/matrix-os",
    })).resolves.toEqual({ tabId: 7, paneId: "terminal_12" });
    expect(tabReads).toBe(2);
  });

  it("resolves tab cwd inside Matrix home and rejects missing or symlink-escaped paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-runtime-tab-cwd-"));
    const homePath = join(root, "home");
    const internalName = "matrix-tab-0123456789abcdef0123456789abcdef";
    const sessionName = "matrix-w-0123456789abcdef0123456789abcdef";
    try {
      await mkdir(join(homePath, "projects/repo"), { recursive: true });
      await mkdir(join(root, "outside"));
      await symlink(join(root, "outside"), join(homePath, "escape"));
      const run = vi.fn(async (args: string[]) => {
        if (args.includes("list-tabs")) return "[]";
        if (args.includes("new-tab")) return "7\n";
        if (args.includes("list-panes")) {
          return JSON.stringify([{ id: 12, is_plugin: false, tab_id: 7 }]);
        }
        return "";
      });
      const adapter = new ZellijCliRuntimeAdapter({ homePath, run });

      await expect(adapter.createTab(sessionName, {
        internalName,
        cwd: "projects/repo",
      })).resolves.toEqual({ tabId: 7, paneId: "terminal_12" });
      expect(run).toHaveBeenCalledWith(expect.arrayContaining([
        "new-tab", "--cwd", await realpath(join(homePath, "projects/repo")),
      ]));

      run.mockClear();
      for (const cwd of ["escape", "missing", "../outside"]) {
        await expect(adapter.createTab(sessionName, { internalName, cwd })).rejects.toThrow();
      }
      expect(run).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run, resolveRealpath: lexicalRealpath });

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
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix", run, resolveRealpath: lexicalRealpath });

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
      resolveRealpath: lexicalRealpath,
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
