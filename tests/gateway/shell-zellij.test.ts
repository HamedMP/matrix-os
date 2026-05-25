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

  it("kills attach processes when the caller aborts", () => {
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const controller = new AbortController();
    const adapter = createZellijAdapter({ execFile: vi.fn(), spawn, timeoutMs: 25 });

    adapter.attachSession("main", { signal: controller.signal });
    controller.abort();

    expect(spawn).toHaveBeenCalledWith(
      "zellij",
      ["attach", "main"],
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(child.kill).toHaveBeenCalled();
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
