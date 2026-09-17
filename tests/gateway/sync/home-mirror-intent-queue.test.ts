import { describe, expect, it, vi } from "vitest";
import { createBoundedPathIntentQueue } from "../../../packages/gateway/src/sync/path-intent-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createBoundedPathIntentQueue", () => {
  it("coalesces the newest pending intent for the same path", async () => {
    const gate = deferred();
    const processed: Array<[string, string]> = [];
    const queue = createBoundedPathIntentQueue<string>({
      maxSize: 3,
      async process(path, intent) {
        if (path === "active.txt") await gate.promise;
        processed.push([path, intent]);
      },
      onError: vi.fn(),
      onOverflow: vi.fn(),
    });

    expect(queue.enqueue("active.txt", "push")).toBe(true);
    expect(queue.enqueue("same.txt", "push")).toBe(true);
    expect(queue.enqueue("same.txt", "delete")).toBe(true);
    gate.resolve();
    await queue.drain();

    expect(processed).toEqual([
      ["active.txt", "push"],
      ["same.txt", "delete"],
    ]);
  });

  it("caps active plus pending paths and reports overflow", async () => {
    const gate = deferred();
    const onOverflow = vi.fn();
    const queue = createBoundedPathIntentQueue<string>({
      maxSize: 2,
      async process(path) {
        if (path === "active.txt") await gate.promise;
      },
      onError: vi.fn(),
      onOverflow,
    });

    expect(queue.enqueue("active.txt", "push")).toBe(true);
    expect(queue.enqueue("pending.txt", "push")).toBe(true);
    expect(queue.enqueue("overflow.txt", "push")).toBe(false);
    expect(onOverflow).toHaveBeenCalledWith("overflow.txt");

    gate.resolve();
    await queue.drain();
    expect(queue.size()).toBe(0);
  });

  it("isolates a failed path and continues processing later intents", async () => {
    const onError = vi.fn();
    const processed: string[] = [];
    const queue = createBoundedPathIntentQueue<string>({
      maxSize: 3,
      async process(path) {
        if (path === "bad.txt") throw new Error("write failed");
        processed.push(path);
      },
      onError,
      onOverflow: vi.fn(),
    });

    queue.enqueue("bad.txt", "push");
    queue.enqueue("good.txt", "push");
    await queue.drain();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), "bad.txt");
    expect(processed).toEqual(["good.txt"]);
  });
});
