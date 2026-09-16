import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewerOutput } from "../../packages/terminal-runtime/src/viewer-output.js";

afterEach(() => vi.useRealTimers());

describe("ordered viewer output", () => {
  it("keeps concurrent asynchronous sends in order and copies queued bytes", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const received: number[] = [];
    const send = createViewerOutput(async (data) => {
      if (data[0] === 1) await pending;
      received.push(data[0]!);
    });
    const first = send(new Uint8Array([1]));
    const data = new Uint8Array([2]);
    const second = send(data);
    data[0] = 9;
    expect(received).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(received).toEqual([1, 2]);
  });

  it.each(["sync", "async"])("does not deliver queued output after %s failure", async (kind) => {
    const failure = new Error("synthetic failure");
    const sink = vi.fn(() => { if (kind === "sync") throw failure; return Promise.reject(failure); });
    const send = createViewerOutput(sink);
    const results = await Promise.allSettled([send(new Uint8Array([1])), send(new Uint8Array([2]))]);
    expect(results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(sink).toHaveBeenCalledOnce();
  });

  it.each(["bytes", "frames"])("caps pending %s and stops the sender", async (limit) => {
    let release!: () => void;
    const sink = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const send = createViewerOutput(sink);
    const pending = [send(new Uint8Array([1]))];
    if (limit === "bytes") pending.push(send(new Uint8Array(1024 * 1024)));
    else for (let i = 0; i < 256; i++) pending.push(send(new Uint8Array(0)));
    const results = Promise.allSettled(pending);
    release();
    expect((await results).some((result) => result.status === "rejected")).toBe(true);
    await expect(send(new Uint8Array([2]))).rejects.toThrow("capacity");
    expect(sink).toHaveBeenCalledOnce();
  });

  it("disposes pending output and clears its timer", async () => {
    vi.useFakeTimers();
    const sink = vi.fn(() => new Promise<void>(() => {}));
    const send = createViewerOutput(sink);
    const results = Promise.allSettled([send(new Uint8Array([1])), send(new Uint8Array([2]))]);
    send.dispose();
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(sink).toHaveBeenCalledOnce();
  });

  it("times out a stuck sender and rejects its queued output", async () => {
    vi.useFakeTimers();
    const sink = vi.fn(() => new Promise<void>(() => {}));
    const send = createViewerOutput(sink);
    const results = Promise.allSettled([send(new Uint8Array([1])), send(new Uint8Array([2]))]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(sink).toHaveBeenCalledOnce();
  });
});
