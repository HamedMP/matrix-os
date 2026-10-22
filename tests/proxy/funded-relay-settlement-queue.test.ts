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

it.each([404, 409])("retains newer exact usage when replaced terminal transport finishes with %s", async (status) => {
  const pending = Promise.withResolvers<void>(); const terminal = vi.fn(() => pending.promise); const finalize = vi.fn(async () => undefined);
  const queue = new SettlementRetryQueue({ capacity: 2, ttlMs: 60_000, retryIntervalMs: 60_000, now: () => 0, terminal, finalize });
  queue.enqueueTerminal({ contractVersion: 1, reservationId: "replacement", tokenId: "credential_123", requestId: "request_1",
    ownerId: "owner", machineId: "machine", runtimeSlot: "primary", startedAt: "2026-09-10T12:00:00.000Z", expiresAt: "2026-09-10T12:10:00.000Z",
    executionId: "execution", terminalState: "failed", terminalAt: "2026-09-10T12:00:30.000Z", outcome: "usage_unknown" });
  await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1)); queue.enqueue(task("replacement"));
  pending.reject(Object.assign(new Error("old terminal rejected"), { status })); await queue.flush();
  expect(queue.pendingIds).toEqual(["replacement"]); await queue.flush(); expect(finalize).toHaveBeenCalledExactlyOnceWith(task("replacement"));
  expect(queue.pendingCount).toBe(0); await queue.close();
});

it("does not evict unrelated exact usage when replacing a terminal task at capacity", async () => {
  const older = Promise.withResolvers<void>(); const finalize = vi.fn((input: ReturnType<typeof task>) => input.reservationId === "older-exact" ? older.promise : Promise.resolve());
  const queue = new SettlementRetryQueue({ capacity: 2, ttlMs: 60_000, retryIntervalMs: 60_000, now: () => 0, terminal: async () => undefined, finalize });
  queue.enqueue(task("older-exact")); await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
  queue.enqueueTerminal({ contractVersion: 1, reservationId: "replacement", tokenId: "credential_123", requestId: "request_1",
    ownerId: "owner", machineId: "machine", runtimeSlot: "primary", startedAt: "2026-09-10T12:00:00.000Z", expiresAt: "2026-09-10T12:10:00.000Z",
    executionId: "execution", terminalState: "failed", terminalAt: "2026-09-10T12:00:30.000Z", outcome: "usage_unknown" });
  queue.enqueue(task("replacement")); const retained = queue.pendingIds;
  older.resolve(); await queue.flush(); await queue.flush(); await queue.close();
  expect(retained).toEqual(["older-exact", "replacement"]);
  expect(finalize.mock.calls.map(([input]) => input.reservationId)).toEqual(["older-exact", "replacement"]);
});
