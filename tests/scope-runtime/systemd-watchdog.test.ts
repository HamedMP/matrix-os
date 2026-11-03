import { afterEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
import { startScopeRuntimeWatchdog } from "../../packages/scope-runtime/src/systemd-watchdog.js";

const env = { NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "60000000", WATCHDOG_PID: String(process.pid) };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
  execFile.mockReset();
  vi.useRealTimers();
});

describe("scope runtime systemd watchdog", () => {
  it("pings through the fixed bounded notifier after startup and then every 15 seconds", async () => {
    vi.useFakeTimers();
    execFile.mockImplementation((_file, _args, _options, callback) => { callback(null); });
    const watchdog = startScopeRuntimeWatchdog({ env });
    closers.push(() => watchdog.close());
    await Promise.resolve();
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith("/usr/bin/systemd-notify", ["WATCHDOG=1"], expect.objectContaining({
      timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16_384,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" }, signal: expect.any(AbortSignal),
    }), expect.any(Function));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(execFile).toHaveBeenCalledTimes(2);
    await watchdog.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {}, { NOTIFY_SOCKET: "/run/systemd/notify" }, { WATCHDOG_USEC: "60000000" },
    { ...env, NOTIFY_SOCKET: "/tmp/untrusted.sock" }, { ...env, NOTIFY_SOCKET: "@untrusted" },
    { ...env, WATCHDOG_USEC: "not-a-timeout" }, { ...env, WATCHDOG_USEC: "0" },
    { ...env, WATCHDOG_USEC: "1e9" }, { ...env, WATCHDOG_USEC: "9007199254740992" },
    { ...env, WATCHDOG_PID: String(process.pid + 1) },
  ])("does not spawn or retain a timer outside the inherited system-service watchdog (%j)", async invalidEnv => {
    vi.useFakeTimers();
    const watchdog = startScopeRuntimeWatchdog({ env: invalidEnv });
    closers.push(() => watchdog.close());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(execFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a bounded notification failure and retries instead of falsely acknowledging a heartbeat", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    execFile.mockImplementationOnce((_file, _args, _options, callback) => { callback(new Error("private socket details")); })
      .mockImplementation((_file, _args, _options, callback) => { callback(null); });
    const watchdog = startScopeRuntimeWatchdog({ env });
    closers.push(() => watchdog.close());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith("scope_runtime_watchdog_notify_failed:", "Error");
  });

  it("allows only one notifier at a time and aborts it when the supervisor closes", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let activeSignal: AbortSignal | undefined;
    execFile.mockImplementation((_file, _args, options, callback) => {
      activeSignal = options.signal as AbortSignal;
      activeSignal.addEventListener("abort", () => { callback(new Error("aborted")); }, { once: true });
    });
    const watchdog = startScopeRuntimeWatchdog({ env });
    closers.push(() => watchdog.close());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(execFile).toHaveBeenCalledOnce();
    await watchdog.close();
    expect(activeSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });
});
