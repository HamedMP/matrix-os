import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  classifyZellijFailure,
  createZellijAdapter,
  sanitizeZellijError,
} from "../../packages/gateway/src/shell/zellij.js";

function childProcess() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

function ptyProcess() {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  return {
    writes: [] as string[],
    resize: vi.fn(),
    kill: vi.fn(),
    write(data: string) {
      this.writes.push(data);
    },
    onData(listener: (data: string) => void) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    emitData(data: string) {
      for (const listener of dataListeners) listener(data);
    },
    emitExit(exitCode: number, signal?: number) {
      for (const listener of exitListeners) listener({ exitCode, signal });
    },
  };
}

describe("zellij adapter", () => {
  it("uses execFile with argument arrays and bounded timeouts", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "main\n", "");
      return child;
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.listSessions()).resolves.toEqual(["main"]);
    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["list-sessions", "--no-formatting"],
      expect.objectContaining({ timeout: 25, signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
  });

  it("treats zellij's no-active-sessions response as an empty session list", async () => {
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(Object.assign(new Error("zellij exited"), { code: 1 }), "", "NO ACTIVE ZELLIJ SESSIONS FOUND\n");
      return childProcess();
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.listSessions()).resolves.toEqual([]);
  });

  it("sanitizes stderr before surfacing execFile errors", async () => {
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(new Error("boom"), "", "failed in /home/alice/.ssh with zellij internals");
      return childProcess();
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.createTab("main", { name: "tools" })).rejects.toMatchObject({
      code: "zellij_failed",
      safeMessage: "Shell operation failed",
    });
  });

  it("classifies a missing zellij binary during session creation for server diagnostics", async () => {
    const missing = Object.assign(new Error("spawn zellij ENOENT"), {
      code: "ENOENT",
      syscall: "spawn zellij",
    });
    const spawnPty = vi.fn(() => {
      throw missing;
    });
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25 });

    await expect(adapter.createSession({ name: "main" })).rejects.toMatchObject({
      code: "zellij_failed",
      diagnostic: {
        binary: "zellij",
        kind: "binary_not_found",
      },
    });
  });

  it("classifies zellij timeouts without exposing stderr", () => {
    const timedOut = Object.assign(new Error("Command timed out"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });

    expect(classifyZellijFailure(timedOut, "details from /home/alice/project")).toEqual({
      binary: "zellij",
      kind: "timeout",
      signal: "SIGTERM",
      stderr: "details from [path]",
    });
  });

  it("keeps errno strings separate from process exit codes", () => {
    const missing = Object.assign(new Error("spawn zellij ENOENT"), {
      code: "ENOENT",
    });
    const failed = Object.assign(new Error("zellij exited"), {
      code: 1,
    });

    expect(classifyZellijFailure(missing, "")).toEqual({
      binary: "zellij",
      errorCode: "ENOENT",
      kind: "binary_not_found",
    });
    expect(classifyZellijFailure(failed, "")).toEqual({
      binary: "zellij",
      exitCode: 1,
      kind: "process_failed",
    });
  });

  it("starts attach through a PTY with a scrubbed zellij environment", () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => pty);
    const controller = new AbortController();
    const adapter = createZellijAdapter({
      execFile: vi.fn(),
      spawnPty,
      timeoutMs: 25,
      env: {
        HOME: "/home/matrix",
        PATH: "/opt/matrix/bin",
        TERM: "screen-256color",
        XDG_RUNTIME_DIR: "/run/user/999",
        ZELLIJ: "0",
        ZELLIJ_CONFIG_DIR: "/home/matrix/.config/zellij",
        ZELLIJ_CONFIG_FILE: "/home/matrix/.config/zellij/config.kdl",
        ZELLIJ_SESSION_NAME: "main",
        ZELLIJ_PANE_ID: "1",
        ZELLIJ_SOCKET_DIR: "/run/user/999/zellij",
        LANG: "fr_FR.UTF-8",
        SECRET_TOKEN: "nope",
      },
      cwd: "/opt/matrix/app",
    });

    adapter.attachSession("main", { signal: controller.signal });

    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["attach", "main"],
      expect.objectContaining({
        cols: 120,
        rows: 40,
        name: "xterm-256color",
        cwd: "/opt/matrix/app",
        env: expect.objectContaining({
          HOME: "/home/matrix",
          PATH: "/opt/matrix/bin",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CLICOLOR: "1",
          FORCE_COLOR: "3",
          LANG: "fr_FR.UTF-8",
          XDG_RUNTIME_DIR: "/run/user/999",
          ZELLIJ_CONFIG_DIR: "/home/matrix/.config/zellij",
          ZELLIJ_CONFIG_FILE: "/home/matrix/.config/zellij/config.kdl",
          ZELLIJ_SOCKET_DIR: "/run/user/999/zellij",
        }),
      }),
    );
    const env = spawnPty.mock.calls[0]?.[2].env;
    expect(env).not.toHaveProperty("ZELLIJ");
    expect(env).not.toHaveProperty("ZELLIJ_SESSION_NAME");
    expect(env).not.toHaveProperty("ZELLIJ_PANE_ID");
    expect(env).not.toHaveProperty("LC_ALL");
    expect(env).not.toHaveProperty("SECRET_TOKEN");
  });

  it("kills attach PTYs when the caller aborts", () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => pty);
    const controller = new AbortController();
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25 });

    adapter.attachSession("main", { signal: controller.signal });
    controller.abort();

    expect(pty.kill).toHaveBeenCalled();
  });

  it("attaches through a PTY so input, output, exit, and resize behave like a real terminal", () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => pty);
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25 });

    const attached = adapter.attachSession("setup");
    attached.write("claude\r");
    attached.resize(140, 50);
    pty.emitData("ready");
    pty.emitExit(0);

    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["attach", "setup"],
      expect.objectContaining({ name: "xterm-256color", cols: 120, rows: 40 }),
    );
    expect(pty.writes).toEqual(["claude\r"]);
    expect(pty.resize).toHaveBeenCalledWith(140, 50);
  });

  it("creates sessions in the requested cwd using a retained PTY", async () => {
    const pty = ptyProcess();
    const execFile = vi.fn();
    const spawnPty = vi.fn(() => pty);
    const adapter = createZellijAdapter({
      execFile,
      spawnPty,
      timeoutMs: 25,
      startupDelayMs: 1,
    });

    await adapter.createSession({ name: "main", cwd: "/home/alice/work" });

    expect(execFile).not.toHaveBeenCalled();
    expect(spawnPty).toHaveBeenCalledWith(
      "zellij",
      ["--session", "main"],
      expect.objectContaining({
        cwd: "/home/alice/work",
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        env: expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CLICOLOR: "1",
          FORCE_COLOR: "3",
        }),
      }),
    );
  });

  it("creates command sessions with the command as the initial focused pane", async () => {
    const pty = ptyProcess();
    let layoutPath: string | undefined;
    let layoutText = "";
    const spawnPty = vi.fn((_command, args) => {
      layoutPath = String(args[3]);
      layoutText = readFileSync(layoutPath, "utf8");
      return pty;
    });
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25, startupDelayMs: 1 });

    await adapter.createSession({
      name: "bench",
      cwd: "/home/alice/work",
      cmd: "node -e 'process.stdout.write(\"MATRIX_BENCH_READY\\n\")'",
    });

    expect(spawnPty).toHaveBeenCalledTimes(1);
    const args = spawnPty.mock.calls[0]?.[1];
    expect(args).toEqual([
      "--session",
      "bench",
      "--new-session-with-layout",
      expect.stringMatching(/matrix-zellij-layout-/),
    ]);
    expect(layoutText).toContain('cwd="/home/alice/work"');
    expect(layoutText).toContain('command="node"');
    expect(layoutText).toContain('args "-e"');
    expect(layoutText).toContain("MATRIX_BENCH_READY");
    expect(layoutPath && existsSync(layoutPath)).toBe(false);
  });

  it("rejects session creation when the retained PTY exits during startup", async () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => {
      setTimeout(() => pty.emitExit(1), 0);
      return pty;
    });
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25, startupDelayMs: 10 });

    await expect(adapter.createSession({ name: "broken" })).rejects.toMatchObject({
      code: "zellij_failed",
      safeMessage: "Shell operation failed",
      diagnostic: {
        binary: "zellij",
        kind: "process_failed",
        exitCode: 1,
      },
    });
  });

  it("preserves numeric PTY signals in startup failure diagnostics", async () => {
    const pty = ptyProcess();
    const spawnPty = vi.fn(() => {
      setTimeout(() => pty.emitExit(0, 15), 0);
      return pty;
    });
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawnPty, timeoutMs: 25, startupDelayMs: 10 });

    await expect(adapter.createSession({ name: "signaled" })).rejects.toMatchObject({
      code: "zellij_failed",
      diagnostic: {
        binary: "zellij",
        kind: "process_failed",
        exitCode: 0,
        signal: "15",
      },
    });
  });

  it("kills retained creation PTYs when deleting sessions", async () => {
    const pty = ptyProcess();
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const spawnPty = vi.fn(() => pty);
    const adapter = createZellijAdapter({ execFile, spawnPty, timeoutMs: 25, startupDelayMs: 1 });

    await adapter.createSession({ name: "main" });
    await adapter.deleteSession("main", { force: true });

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["delete-session", "main", "--force"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("evicts the oldest retained creation PTY when the cap is reached", async () => {
    const first = ptyProcess();
    const second = ptyProcess();
    const spawnPty = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const adapter = createZellijAdapter({
      execFile: vi.fn(),
      spawnPty,
      timeoutMs: 25,
      startupDelayMs: 1,
      maxRetainedPtys: 1,
    });

    await adapter.createSession({ name: "first" });
    await adapter.createSession({ name: "second" });

    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(second.kill).not.toHaveBeenCalled();
  });

  it("creates tabs and panes with terminal-capable environment at process launch", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const adapter = createZellijAdapter({
      execFile,
      spawn: vi.fn(),
      timeoutMs: 25,
      env: { TERM: "dumb", COLORTERM: "", PATH: "/usr/bin" },
    });

    await adapter.createTab("main", { name: "tools" });
    await adapter.splitPane("main", { direction: "right" });

    for (const call of execFile.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CLICOLOR: "1",
          FORCE_COLOR: "3",
        }),
      }));
    }
  });

  it("splits multi-word commands into argv tokens for zellij actions", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await adapter.createTab("main", { cmd: "bun run test" });
    await adapter.splitPane("main", { direction: "down", cmd: "tail -f '/tmp/my log'" });

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "zellij",
      ["--session", "main", "action", "new-tab", "--", "bun", "run", "test"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "zellij",
      ["--session", "main", "action", "new-pane", "--down", "--", "tail", "-f", "/tmp/my log"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("redacts paths from zellij stderr", () => {
    expect(sanitizeZellijError("bad /home/alice/projects/app and /tmp/file")).toBe(
      "bad [path] and [path]",
    );
  });
});
