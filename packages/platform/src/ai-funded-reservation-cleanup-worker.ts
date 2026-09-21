export interface AiFundedReservationCleanupWorker {
  shutdown(): Promise<void>;
}

export function createAiFundedReservationCleanupWorker(options: {
  cleanupExpiredReservations(input: { limit: number }): Promise<number>;
  intervalMs?: number;
  batchSize?: number;
}): AiFundedReservationCleanupWorker {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 24 * 60 * 60_000
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("Funded reservation cleanup policy is invalid");
  }

  let cleanupPromise: Promise<void> | undefined;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const runCleanup = (): void => {
    if (shuttingDown || cleanupPromise) return;
    const running = Promise.resolve()
      .then(() => options.cleanupExpiredReservations({ limit: batchSize }))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn(
          "[funded-ai] reservation cleanup failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      })
      .finally(() => {
        if (cleanupPromise === running) cleanupPromise = undefined;
      });
    cleanupPromise = running;
  };

  runCleanup();
  const cleanupTimer = setInterval(runCleanup, intervalMs);
  cleanupTimer.unref?.();

  return {
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      clearInterval(cleanupTimer);
      shutdownPromise = cleanupPromise ?? Promise.resolve();
      return shutdownPromise;
    },
  };
}
