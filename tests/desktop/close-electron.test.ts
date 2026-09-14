import { EventEmitter } from "node:events";
import type { ElectronApplication } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeElectronApp } from "../e2e/desktop/fixtures/close-electron";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => { child.signalCode = "SIGKILL"; child.emit("exit"); return true; }),
  });
  const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const app = { process: () => child, close } as unknown as ElectronApplication;
  return { child, close, app };
}

afterEach(() => vi.useRealTimers());

describe("bounded Electron E2E shutdown", () => {
  it("closes gracefully without killing the process", async () => {
    const { app, child } = fixture();
    await closeElectronApp(app, 10);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("finishes after process exit even if Playwright close never resolves", async () => {
    vi.useFakeTimers();
    const { app, child, close } = fixture();
    close.mockImplementation(() => new Promise(() => {}));
    const finished = vi.fn();
    const pending = closeElectronApp(app, 10).then(finished);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(finished).toHaveBeenCalledOnce();
    await pending;
  });

  it("does not kill an already signal-terminated process", async () => {
    vi.useFakeTimers();
    const { app, child, close } = fixture();
    child.signalCode = "SIGTERM";
    close.mockImplementation(() => new Promise(() => {}));
    const finished = vi.fn();
    const pending = closeElectronApp(app, 10).then(finished);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledOnce();
    await pending;
  });

  it("reports a process that does not exit after a forced kill", async () => {
    vi.useFakeTimers();
    const { app, child, close } = fixture();
    child.kill.mockImplementation(() => true);
    close.mockImplementation(() => new Promise(() => {}));
    const failed = vi.fn();
    const pending = closeElectronApp(app, 10).catch(failed);
    await vi.advanceTimersByTimeAsync(20);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Electron test process did not exit" }));
    await pending;
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
