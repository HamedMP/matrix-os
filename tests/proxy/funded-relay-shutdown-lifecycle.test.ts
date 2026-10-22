import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayRequestDrain, waitForRelayWork } from "../../packages/proxy/src/funded-relay-lifecycle.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function deadline(ms: number) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("Shutdown deadline", "TimeoutError")), ms);
  return controller.signal;
}

describe("shared Relay shutdown deadline", () => {
  it("distinguishes completed work from a timeout or rejected work", async () => {
    expect(await waitForRelayWork(Promise.resolve(), 100)).toBe(true);
    expect(await waitForRelayWork(Promise.resolve(false), 100)).toBe(false);
    expect(await waitForRelayWork(Promise.reject(new Error("failed")), 100)).toBe(false);
    const waiting = waitForRelayWork(new Promise(() => undefined), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBe(false);
  });

  it("uses the same deadline for sequential phases without renewing the budget", async () => {
    const signal = deadline(9000);
    const first = waitForRelayWork(new Promise((resolve) => setTimeout(resolve, 7000)), signal);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await first).toBe(true);
    let secondResult: unknown = "pending";
    const second = waitForRelayWork(new Promise((resolve) => setTimeout(resolve, 3000)), signal)
      .then((result) => { secondResult = result; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(secondResult).toBe(false);
    await second;
  });

  it("does not call an already expired deadline successful", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await waitForRelayWork(Promise.resolve(), controller.signal)).toBe(false);
  });

  it("reports an unconfirmed cancellation incomplete at the shared deadline", async () => {
    const drain = createRelayRequestDrain(); const request = new AbortController();
    drain.add(request);
    let result: unknown = "pending";
    const closing = drain.close(10_000, deadline(9000)).then((value) => { result = value; });
    expect(request.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(result).toBe(false);
    drain.delete(request);
    await vi.advanceTimersByTimeAsync(1000);
    await closing;
  });
});
