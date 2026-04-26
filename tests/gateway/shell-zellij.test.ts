import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
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

  it("redacts paths from zellij stderr", () => {
    expect(sanitizeZellijError("bad /home/alice/projects/app and /tmp/file")).toBe(
      "bad [path] and [path]",
    );
  });
});
