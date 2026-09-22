import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiFundedReservationCleanupWorker } from "../../packages/platform/src/ai-funded-reservation-cleanup-worker.js";

describe("funded reservation cleanup worker", () => {
  afterEach(() => vi.useRealTimers());

  it("runs a bounded startup sweep, suppresses overlap, and drains on shutdown", async () => {
    vi.useFakeTimers();
    const cleanupResult = Promise.withResolvers<number>();
    const cleanupExpiredReservations = vi.fn(() => cleanupResult.promise);
    const worker = createAiFundedReservationCleanupWorker({
      cleanupExpiredReservations,
      intervalMs: 1_000,
      batchSize: 7,
    });

    await Promise.resolve();
    expect(cleanupExpiredReservations).toHaveBeenCalledWith({ limit: 7 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cleanupExpiredReservations).toHaveBeenCalledTimes(1);

    let stopped = false;
    const shutdown = worker.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    cleanupResult.resolve(1);
    await shutdown;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cleanupExpiredReservations).toHaveBeenCalledTimes(1);
  });
});
