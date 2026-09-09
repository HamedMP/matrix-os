import { afterEach, describe, expect, it, vi } from "vitest";
import { startTerminalOrphanSweepLifecycle } from "../../packages/terminal-runtime/src/orphan-sweep-lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal orphan sweep lifecycle", () => {
  it("runs immediately, serializes recurring sweeps, and stops cleanly", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstSweep = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sweep = vi.fn()
      .mockImplementationOnce(async () => {
        await firstSweep;
        return { scanned: 1, deleted: 1, failed: 0 };
      })
      .mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });

    const lifecycle = startTerminalOrphanSweepLifecycle({
      intervalMs: 1_000,
      sweep,
      logCompleted: vi.fn(),
      logFailed: vi.fn(),
    });

    await Promise.resolve();
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    await lifecycle.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("logs sweep failures without terminating the control service", async () => {
    vi.useFakeTimers();
    const failure = new Error("test failure");
    const logFailed = vi.fn();
    const lifecycle = startTerminalOrphanSweepLifecycle({
      intervalMs: 1_000,
      sweep: vi.fn().mockRejectedValue(failure),
      logCompleted: vi.fn(),
      logFailed,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(logFailed).toHaveBeenCalledWith(failure);
    await lifecycle.close();
  });

  it("bounds shutdown when an active sweep does not settle", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => new Promise<never>(() => undefined));
    const logFailed = vi.fn();
    const lifecycle = startTerminalOrphanSweepLifecycle({
      intervalMs: 1_000,
      closeWaitMs: 250,
      sweep,
      logCompleted: vi.fn(),
      logFailed,
    });

    await Promise.resolve();
    expect(sweep).toHaveBeenCalledTimes(1);
    const closing = lifecycle.close();
    await vi.advanceTimersByTimeAsync(250);
    await expect(closing).resolves.toBeUndefined();
    expect(logFailed).toHaveBeenCalledWith(expect.objectContaining({
      name: "TerminalOrphanSweepCloseTimeoutError",
    }));
  });
});
