import { EventEmitter } from "node:events";
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
  return {
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
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

  it("sanitizes stderr before surfacing errors", async () => {
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(new Error("boom"), "", "failed in /home/alice/.ssh with zellij internals");
      return childProcess();
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await expect(adapter.createSession({ name: "main" })).rejects.toMatchObject({
      code: "zellij_failed",
      safeMessage: "Shell operation failed",
    });
  });

  it("classifies a missing zellij binary for server diagnostics", async () => {
    const missing = Object.assign(new Error("spawn zellij ENOENT"), {
      code: "ENOENT",
      syscall: "spawn zellij",
    });
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(missing, "", "");
      return childProcess();
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

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

  it("creates sessions in the requested cwd using headless attach", async () => {
    const child = childProcess();
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "", "");
      return child;
    });
    const adapter = createZellijAdapter({ execFile, spawn: vi.fn(), timeoutMs: 25 });

    await adapter.createSession({ name: "main", cwd: "/home/alice/work" });

    expect(execFile).toHaveBeenCalledWith(
      "zellij",
      ["--session", "main", "attach", "--create-background", "main"],
      expect.objectContaining({ timeout: 25, cwd: "/home/alice/work" }),
      expect.any(Function),
    );
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
