import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeHeartbeatTimeoutError, startRuntimeHeartbeat } from "../../../packages/gateway/src/bots/runtime-heartbeat.js";

afterEach(() => vi.useRealTimers());

describe("runtime heartbeat", () => {
  it("starts immediately, skips overlapping ticks, and waits for renewal before stopping", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const renew = vi.fn(async () => { await gate; });
    const onFailure = vi.fn();
    const heartbeat = startRuntimeHeartbeat(renew, onFailure, 1_000);
    await Promise.resolve();
    expect(renew).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledOnce();
    const stopping = heartbeat.stop();
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a failed renewal once and permits stopping from the failure callback", async () => {
    vi.useFakeTimers();
    const error = new Error("lease lost");
    const renew = vi.fn(async () => { throw error; });
    let heartbeat!: ReturnType<typeof startRuntimeHeartbeat>;
    let stopped!: Promise<void>;
    const onFailure = vi.fn(() => { stopped = heartbeat.stop(); });
    heartbeat = startRuntimeHeartbeat(renew, onFailure, 1_000);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledExactlyOnceWith(error));
    await stopped;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledOnce();
  });

  it("treats even an undefined rejection as a failed renewal", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => Promise.reject(undefined));
    const onFailure = vi.fn();
    const heartbeat = startRuntimeHeartbeat(renew, onFailure, 1_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledOnce();
    await heartbeat.stop();
  });

  it("contains rejection from an asynchronous failure callback", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const heartbeat = startRuntimeHeartbeat(async () => { throw new Error("lease lost"); },
        async () => { throw new Error("callback failed"); });
      await vi.advanceTimersByTimeAsync(1);
      expect(warning).toHaveBeenCalledWith("[bots] runtime renewal failure callback failed", "Error");
      await heartbeat.stop();
    } finally { warning.mockRestore(); }
  });

  it("aborts a hung renewal at the 30 second deadline and reports failure once", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const renew = vi.fn(async (signal: AbortSignal) => {
      observedSignal = signal;
      await new Promise<void>(() => undefined);
    });
    const onFailure = vi.fn();
    const heartbeat = startRuntimeHeartbeat(renew, onFailure);
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(observedSignal?.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.any(RuntimeHeartbeatTimeoutError));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledOnce();
    await heartbeat.stop();
  });

  it("stops a renewal that ignores abort within a bounded drain", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const renew = vi.fn(async (signal: AbortSignal) => { observedSignal = signal; await gate; });
    const onFailure = vi.fn();
    const heartbeat = startRuntimeHeartbeat(renew, onFailure);
    await Promise.resolve();
    let stopped = false;
    const stopping = heartbeat.stop().then(() => { stopped = true; });
    expect(observedSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
    finish();
    await Promise.resolve();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
