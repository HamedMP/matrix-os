import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettlementRetryQueue } from "../../packages/proxy/src/funded-relay-settlement-queue.js";

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function deadline(ms: number) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("Shutdown deadline", "TimeoutError")), ms);
  return controller.signal;
}
const exact = (reservationId: string) => ({ reservationId, tokenId: "credential_123", mode: "exact" as const, actualCostMicrousd: 42 });
const terminal = (reservationId: string) => ({ contractVersion: 1 as const, reservationId, tokenId: "credential_123", requestId: "request_1",
  ownerId: "owner", machineId: "machine", runtimeSlot: "primary", startedAt: "2026-09-10T12:00:00.000Z", expiresAt: "2026-09-10T12:10:00.000Z",
  executionId: "execution", terminalState: "cancelled" as const, terminalAt: "2026-09-10T12:00:30.000Z", outcome: "usage_unknown" as const });

describe("settlement queue shutdown confirmation", () => {
  it("returns incomplete within the shared deadline even if a transport ignores abort", async () => {
    const response = Promise.withResolvers<void>();
    const queue = new SettlementRetryQueue({ capacity: 2, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: () => response.promise, finalize: async () => undefined });
    const acknowledged = queue.enqueueTerminal(terminal("pending"));
    let result: unknown = "pending";
    const closing = queue.close(deadline(9000)).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(9000);
    expect(result).toBe(false);
    expect(await acknowledged).toBe(false);
    response.resolve();
    await closing;
    expect(await queue.close()).toBe(false);
  });

  it("does not convert a late transport ACK after the deadline into confirmation", async () => {
    const response = Promise.withResolvers<void>();
    const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: () => response.promise, finalize: async () => undefined });
    let ack: unknown = "pending";
    queue.enqueueTerminal(terminal("late")).then((value) => { ack = value; });
    const closing = queue.close(deadline(9000));
    await vi.advanceTimersByTimeAsync(9000);
    expect(ack).toBe(false);
    response.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(await closing).toBe(false);
    expect(ack).toBe(false);
  });

  it("does not let a replaced terminal's late ACK confirm or dispatch newer exact work", async () => {
    const response = Promise.withResolvers<void>(); const finalized: string[] = [];
    const queue = new SettlementRetryQueue({ capacity: 2, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: () => response.promise, finalize: async (task) => { finalized.push(task.reservationId); } });
    const acknowledged = queue.enqueueTerminal(terminal("replacement"));
    queue.enqueue(exact("replacement"));
    const closing = queue.close(deadline(9000));
    await vi.advanceTimersByTimeAsync(9000);
    expect(await closing).toBe(false); expect(await acknowledged).toBe(false);
    response.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(finalized).toEqual([]);
    expect(await queue.close()).toBe(false);
  });

  it("keeps a failed close incomplete when an unacknowledged item expires", async () => {
    const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 100, retryIntervalMs: 60_000, now: Date.now,
      terminal: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); throw new Error("unavailable"); },
      finalize: async () => undefined });
    const acknowledged = queue.enqueueTerminal(terminal("expires"));
    const closing = queue.close(deadline(9000));
    await vi.advanceTimersByTimeAsync(200);
    expect(await acknowledged).toBe(false);
    expect(await closing).toBe(false);
  });

  it("does not mistake a nonretryable rejection for an acknowledged drain", async () => {
    const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: async () => { throw Object.assign(new Error("rejected"), { status: 409 }); }, finalize: async () => undefined });
    const acknowledged = queue.enqueueTerminal(terminal("rejected"));
    const closing = queue.close(deadline(9000));
    expect(await acknowledged).toBe(false);
    expect(await closing).toBe(false);
  });

  it("does not poison a new shutdown with an already handled historical rejection", async () => {
    const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: async () => { throw Object.assign(new Error("old rejection"), { status: 409 }); }, finalize: async () => undefined });
    const acknowledged = queue.enqueueTerminal(terminal("historical"));
    await queue.flush(); expect(await acknowledged).toBe(false);
    queue.beginShutdown(deadline(9000));
    expect(await queue.close()).toBe(true);
  });

  it("allows acknowledged exact usage to supersede a closing-period terminal rejection", async () => {
    const response = Promise.withResolvers<void>(); const finalized: string[] = [];
    const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: () => response.promise, finalize: async (task) => { finalized.push(task.reservationId); } });
    const acknowledged = queue.enqueueTerminal(terminal("replacement"));
    queue.beginShutdown(deadline(9000));
    response.reject(Object.assign(new Error("terminal rejected"), { status: 409 }));
    await queue.flush(); expect(await acknowledged).toBe(false);
    queue.enqueue(exact("replacement")); await queue.flush();
    expect(await queue.close()).toBe(true);
    expect(finalized).toEqual(["replacement"]);
  });

  it("keeps tracking overflow incomplete even after all retained entries are acknowledged", async () => {
    const response = Promise.withResolvers<void>();
    const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: () => response.promise, finalize: async (task) => {
        if (task.reservationId === "untracked") throw Object.assign(new Error("untracked rejection"), { status: 409 });
      } });
    const acknowledged = queue.enqueueTerminal(terminal("retained"));
    queue.beginShutdown(deadline(9000));
    queue.enqueue(exact("untracked")); // Evicts pending, but must not erase its tracked failure.
    response.resolve(); await queue.flush(); await queue.flush();
    expect(await acknowledged).toBe(false);
    queue.enqueue(exact("retained")); await queue.flush();
    expect(queue.pendingCount).toBe(0);
    expect(await queue.close()).toBe(false);
  });

  it("bounds retries when the platform immediately rejects without progress", async () => {
    let attempts = 0;
    const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      terminal: async () => { attempts++; throw Object.assign(new Error("unavailable"), { status: 503 }); }, finalize: async () => undefined });
    const acknowledged = queue.enqueueTerminal(terminal("unavailable"));
    const closing = queue.close(deadline(9000));
    await vi.advanceTimersByTimeAsync(9000);
    expect(await closing).toBe(false);
    expect(await acknowledged).toBe(false);
    expect(attempts).toBeLessThanOrEqual(3);
  });

  it("does not renew the budget for a second backlog batch", async () => {
    const calls: string[] = [];
    const queue = new SettlementRetryQueue({ capacity: 3, batchSize: 1, ttlMs: 60_000, retryIntervalMs: 60_000, now: Date.now,
      finalize: async (task) => { calls.push(task.reservationId); await new Promise((resolve) => setTimeout(resolve, 7000)); } });
    queue.enqueue(exact("first")); queue.enqueue(exact("second"));
    let result: unknown = "pending";
    const closing = queue.close(deadline(9000)).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(9000);
    expect(result).toBe(false);
    expect(calls).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(6000);
    await closing;
    expect(await queue.close()).toBe(false);
  });
});
