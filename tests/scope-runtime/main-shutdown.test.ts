import { expect, it, vi } from "vitest";

const { serverClose, watchdogClose } = vi.hoisted(() => ({ serverClose: vi.fn(), watchdogClose: vi.fn() }));
vi.mock("../../packages/scope-runtime/src/server.js", () => ({
  createScopeRuntimeServer: () => ({ start: async () => {}, close: serverClose }),
}));
vi.mock("../../packages/scope-runtime/src/supervisor.js", () => ({ createScopeRuntimeController: async () => ({}) }));
vi.mock("../../packages/scope-runtime/src/systemd-launcher.js", () => ({
  createSystemdScopeRuntimeLauncher: () => ({}), nextExecutionGeneration: async () => "1",
}));
vi.mock("../../packages/scope-runtime/src/systemd-watchdog.js", () => ({
  startScopeRuntimeWatchdog: () => ({ close: watchdogClose }),
}));

it("starts shutdown without waiting on the watchdog, then retries a refused close on the same signal", async () => {
  const signals = ["SIGTERM", "SIGINT"] as const;
  const before = signals.map(signal => process.rawListeners(signal));
  const owned = (index: number) => process.rawListeners(signals[index]!).filter(fn => !before[index]!.includes(fn));
  const previousExit = process.exitCode;
  const write = process.stdout.write.bind(process.stdout);
  const ready = vi.spyOn(process.stdout, "write").mockImplementation((chunk, ...args) =>
    chunk === "scope_runtime_supervisor_ready\n" ? true : write(chunk, ...args));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const watchdog = Promise.withResolvers<void>();
  watchdogClose.mockImplementation(() => watchdog.promise);
  serverClose.mockRejectedValueOnce(new Error("unsafe")).mockResolvedValue(undefined);
  try {
    await import("../../packages/scope-runtime/src/main.js");
    await vi.waitFor(() => expect(owned(0)).toHaveLength(1));
    expect(ready).toHaveBeenCalledWith("scope_runtime_supervisor_ready\n");
    owned(0)[0]!.call(process);
    expect.soft(serverClose).toHaveBeenCalledOnce();
    expect.soft(watchdogClose.mock.invocationCallOrder[0]).toBeLessThan(serverClose.mock.invocationCallOrder[0]!);
    watchdog.resolve();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("scope_runtime_supervisor_shutdown_failed:", "Error"));
    expect(owned(0)).toHaveLength(1);
    owned(0)[0]!.call(process);
    await vi.waitFor(() => expect(process.exitCode).toBe(0));
    expect(serverClose).toHaveBeenCalledTimes(2);
  } finally {
    watchdog.resolve();
    signals.forEach((signal, index) => { for (const fn of owned(index)) process.off(signal, fn as () => void); });
    process.exitCode = previousExit;
    log.mockRestore();
    ready.mockRestore();
  }
});
