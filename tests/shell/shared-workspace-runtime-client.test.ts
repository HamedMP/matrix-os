import { afterEach, describe, expect, it, vi } from "vitest";
import { startSharedWorkspaceRuntime } from "../../shell/src/lib/shared-workspace-runtime";
afterEach(() => vi.useRealTimers());

describe("shared runtime polling orchestration", () => {
  it("aborts both requests and discards late responses after cleanup", async () => {
    const finish: ((value: unknown) => void)[] = [];
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise((resolve) => finish.push(resolve));
    });
    const publish = vi.fn();
    const stop = startSharedWorkspaceRuntime(publish, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const resolve of finish) resolve({ ok: false, status: 403 });
    await Promise.resolve(); await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });
  it("continues one authoritative status loop when wake fails ambiguously", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const fetcher = vi.fn((url: string | URL | Request) => String(url).endsWith("/api/workspace/actions")
      ? Promise.reject(new Error("network timeout")) : Promise.resolve({ ok: true, json: async () => ({ state: "ready" }) }));
    const stop = startSharedWorkspaceRuntime(publish, fetcher as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenLastCalledWith("ready");
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/workspace/runtime"))).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/workspace/runtime"))).toHaveLength(2);
  });
});
