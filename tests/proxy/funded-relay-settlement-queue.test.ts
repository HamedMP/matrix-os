import { describe, expect, it, vi } from "vitest";
import { SettlementRetryQueue } from "../../packages/proxy/src/funded-relay-settlement-queue.js";

function task(reservationId: string) {
  return { reservationId, tokenId: "credential_123", mode: "exact" as const, actualCostMicrousd: 42 };
}

describe("funded settlement retry queue", () => {
  it("retries idempotent finalization and removes it only after success", async () => {
    const finalize = vi.fn()
      .mockRejectedValueOnce(new Error("private platform failure"))
      .mockResolvedValueOnce(undefined);
    const queue = new SettlementRetryQueue({
      capacity: 2, ttlMs: 60_000, retryIntervalMs: 60_000, now: () => 0, finalize,
    });
    queue.enqueue(task("reservation_1"));
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
    expect(queue.pendingCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await queue.flush();
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(queue.pendingCount).toBe(0);
    await queue.close();
  });

  it("caps entries, evicts oldest work, and drops stale retries", async () => {
    let clock = 0;
    const finalize = vi.fn().mockRejectedValue(new Error("unavailable"));
    const queue = new SettlementRetryQueue({
      capacity: 1, ttlMs: 100, retryIntervalMs: 60_000, now: () => clock, finalize,
    });
    queue.enqueue(task("reservation_old"));
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());
    queue.enqueue(task("reservation_new"));
    expect(queue.pendingIds).toEqual(["reservation_new"]);
    clock = 101;
    queue.sweepExpired();
    expect(queue.pendingCount).toBe(0);
    await queue.close();
  });

  it("performs one explicit final drain during shutdown", async () => {
    const finalize = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(undefined);
    const queue = new SettlementRetryQueue({
      capacity: 2, ttlMs: 60_000, retryIntervalMs: 60_000, now: () => 0, finalize,
    });
    queue.enqueue(task("reservation_shutdown"));
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
    await queue.close();
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(queue.pendingCount).toBe(0);
  });
});
