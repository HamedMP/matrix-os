// Tests for the connect-flow backoff poller: after the OAuth consent page is
// opened externally, the desktop polls POST /api/integrations/sync with
// growing intervals until the new connection shows up or the window expires.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startConnectPoll } from "../../desktop/src/renderer/src/features/integrations";

describe("startConnectPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls with backoff until isDone reports the new connection", async () => {
    const ticks: number[] = [];
    let connected = false;
    const onSettled = vi.fn();

    startConnectPoll({
      intervals: [1000, 2000, 4000],
      tick: () => {
        ticks.push(Date.now());
        if (ticks.length === 2) connected = true;
        return Promise.resolve();
      },
      isDone: () => connected,
      onSettled,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(1);
    expect(onSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toHaveLength(2);
    expect(onSettled).toHaveBeenCalledWith(true);

    // No further polling once settled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveLength(2);
  });

  it("gives up with found=false after the intervals are exhausted", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const onSettled = vi.fn();

    startConnectPoll({
      intervals: [100, 100],
      tick,
      isDone: () => false,
      onSettled,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith(false);
  });

  it("keeps polling when a tick throws (transient proxy errors)", async () => {
    let calls = 0;
    const onSettled = vi.fn();

    startConnectPoll({
      intervals: [100, 100, 100],
      tick: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("boom"));
        return Promise.resolve();
      },
      isDone: () => calls >= 2,
      onSettled,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(onSettled).toHaveBeenCalledWith(true);
  });

  it("stops immediately when cancelled", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const onSettled = vi.fn();

    const cancel = startConnectPoll({
      intervals: [100, 100, 100],
      tick,
      isDone: () => false,
      onSettled,
    });

    cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
