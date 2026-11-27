import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installBrokenPipeGuard } from "../../desktop/src/main/stdio-guard";

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

// Regression for an Electron 45 Desktop crash on macOS: after the test runner
// holding the app's stdio pipes exited, console.warn hit EPIPE and Electron
// showed "Uncaught Exception: write EPIPE" (stream error with no listener).
describe("main-process broken stdout/stderr pipe", () => {
  it("ignores EPIPE and EBADF but does not hide other stream errors", () => {
    const stream = new EventEmitter();
    const rethrow = vi.fn();
    installBrokenPipeGuard([stream], { rethrow });

    stream.emit("error", errorWithCode("EPIPE"));
    stream.emit("error", errorWithCode("EBADF"));
    expect(rethrow).not.toHaveBeenCalled();

    const other = errorWithCode("EIO");
    stream.emit("error", other);
    expect(rethrow).toHaveBeenCalledWith(other);
  });

  it("installs one listener per stream even when called twice", () => {
    const stream = new EventEmitter();
    installBrokenPipeGuard([stream]);
    installBrokenPipeGuard([stream]);
    expect(stream.listenerCount("error")).toBe(1);
  });
});
