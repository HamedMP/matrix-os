import { describe, expect, it, vi } from "vitest";
import { createCoalescedBridgeDataHandler } from "../../shell/src/lib/app-data-write-queue.js";

describe("serialized app data writes", () => {
  it("keeps one write in flight, coalesces to the latest value, and makes reads wait", async () => {
    let finishFirst: (() => void) | undefined;
    let finishLatest: (() => void) | undefined;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishLatest = resolve;
      }))
      .mockResolvedValueOnce("latest");
    const handle = createCoalescedBridgeDataHandler(request);

    const first = handle("write", "notes", "draft", "first");
    const second = handle("write", "notes", "draft", "second");
    const third = handle("write", "notes", "draft", "third");
    const read = handle("read", "notes", "draft", undefined);
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    finishFirst?.();
    await first;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]).toEqual(["write", "notes", "draft", "third"]);
    finishLatest?.();
    await Promise.all([second, third]);
    await expect(read).resolves.toBe("latest");
    expect(request.mock.calls.map((call) => call[0])).toEqual(["write", "write", "read"]);
  });

  it("continues the write queue after a failed request", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const handle = createCoalescedBridgeDataHandler(request);

    await expect(handle("write", "notes", "draft", "first")).rejects.toThrow("offline");
    await expect(handle("write", "notes", "draft", "second")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects new active keys after the bounded queue reaches capacity", async () => {
    const request = vi.fn(() => new Promise<void>(() => undefined));
    const handle = createCoalescedBridgeDataHandler(request, 1);

    void handle("write", "notes", "first", "value");
    await expect(handle("write", "notes", "second", "value")).rejects.toThrow(
      "Too many active app data keys",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
