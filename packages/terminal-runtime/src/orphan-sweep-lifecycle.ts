export interface TerminalOrphanSweepResult {
  scanned: number;
  deleted: number;
  failed: number;
}

class TerminalOrphanSweepCloseTimeoutError extends Error {
  constructor() {
    super("Terminal orphan sweep did not settle before shutdown");
    this.name = "TerminalOrphanSweepCloseTimeoutError";
  }
}

export function startTerminalOrphanSweepLifecycle(options: {
  intervalMs: number;
  closeWaitMs?: number;
  sweep: () => Promise<TerminalOrphanSweepResult>;
  logCompleted: (result: TerminalOrphanSweepResult) => void;
  logFailed: (error: unknown) => void;
}): { close: () => Promise<void> } {
  const closeWaitMs = options.closeWaitMs ?? 5_000;
  if (!Number.isSafeInteger(closeWaitMs) || closeWaitMs < 1 || closeWaitMs > 60_000) {
    throw new TypeError("Terminal orphan sweep close wait must be a positive bounded integer");
  }
  let closed = false;
  let activeSweep: Promise<void> | null = null;

  const run = () => {
    if (closed || activeSweep) return;
    const sweep = Promise.resolve()
      .then(options.sweep)
      .then(options.logCompleted)
      .catch(options.logFailed);
    activeSweep = sweep;
    void sweep.finally(() => {
      if (activeSweep === sweep) activeSweep = null;
    });
  };

  run();
  const timer = setInterval(run, options.intervalMs);
  timer.unref?.();

  return {
    async close() {
      closed = true;
      clearInterval(timer);
      const pendingSweep = activeSweep;
      if (!pendingSweep) return;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        pendingSweep.then(() => false),
        new Promise<true>((resolveTimeout) => {
          closeTimer = setTimeout(() => resolveTimeout(true), closeWaitMs);
          closeTimer.unref?.();
        }),
      ]);
      if (closeTimer) clearTimeout(closeTimer);
      if (timedOut) options.logFailed(new TerminalOrphanSweepCloseTimeoutError());
    },
  };
}
