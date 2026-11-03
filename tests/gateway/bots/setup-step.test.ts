import { afterEach, describe, expect, it, vi } from "vitest";
import { runBotSetupStep } from "../../../packages/gateway/src/bots/setup-step.js";

afterEach(() => { vi.useRealTimers(); });

describe("Recipe Bot setup step", () => {
  it("does not start a queued operation after Stop", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => "unused");
    const step = runBotSetupStep(operation, controller.signal);
    controller.abort();
    await expect(step).rejects.toMatchObject({ code: "aborted" });
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
  });

  it("runs a late cleanup once after timing out an operation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish: (value: string) => void = () => undefined;
    const cleanup = vi.fn();
    const step = runBotSetupStep(() => new Promise<string>((resolve) => { finish = resolve; }), controller.signal, cleanup);
    await Promise.resolve();
    const rejected = expect(step).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    finish("late resource");
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith("late resource");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives each preparation call its own minute", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const prepare = async () => runBotSetupStep(() => new Promise<string>((resolve) => {
      setTimeout(() => resolve("ready"), 59_000);
    }), signal);
    const first = prepare();
    await vi.advanceTimersByTimeAsync(59_000);
    await expect(first).resolves.toBe("ready");
    const second = prepare();
    await vi.advanceTimersByTimeAsync(59_000);
    await expect(second).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });
});
