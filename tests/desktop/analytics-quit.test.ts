import { describe, expect, it, vi } from "vitest";
import { createAnalyticsBeforeQuit } from "@desktop/main/analytics-quit";

describe("bounded Desktop analytics quit", () => {
  it("waits for renderer flush once and then re-enters the normal quit path", async () => {
    let finishFlush: (() => void) | undefined;
    const requestFlush = vi.fn(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    const quit = vi.fn();
    const handler = createAnalyticsBeforeQuit({ requestFlush, quit, timeoutMs: 50 });
    const firstEvent = { preventDefault: vi.fn() };

    handler(firstEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(requestFlush).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    finishFlush?.();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    const reenteredEvent = { preventDefault: vi.fn() };
    handler(reenteredEvent);
    expect(reenteredEvent.preventDefault).not.toHaveBeenCalled();
    expect(requestFlush).toHaveBeenCalledOnce();
  });

  it("continues quitting when renderer flush stalls", async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const handler = createAnalyticsBeforeQuit({
      requestFlush: vi.fn(() => new Promise<void>(() => undefined)),
      quit,
      timeoutMs: 750,
    });

    handler({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(749);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(quit).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("contains renderer flush rejection and still quits", async () => {
    const quit = vi.fn();
    const handler = createAnalyticsBeforeQuit({
      requestFlush: vi.fn(async () => { throw new Error("renderer private failure"); }),
      quit,
      timeoutMs: 50,
    });

    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });
});
