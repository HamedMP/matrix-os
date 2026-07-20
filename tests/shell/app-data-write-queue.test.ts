import { describe, expect, it, vi } from "vitest";
import { createSerializedBridgeDataHandler } from "../../shell/src/lib/app-data-write-queue.js";

describe("serialized app data writes", () => {
  it("starts bridge writes in order and makes reads wait for prior writes", async () => {
    let finishFirst: (() => void) | undefined;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("latest");
    const handle = createSerializedBridgeDataHandler(request);

    const first = handle("write", "notes", "draft", "first");
    const second = handle("write", "notes", "draft", "second");
    const read = handle("read", "notes", "draft", undefined);
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    finishFirst?.();
    await first;
    await second;
    await expect(read).resolves.toBe("latest");
    expect(request.mock.calls.map((call) => call[0])).toEqual(["write", "write", "read"]);
  });

  it("continues the write queue after a failed request", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const handle = createSerializedBridgeDataHandler(request);

    await expect(handle("write", "notes", "draft", "first")).rejects.toThrow("offline");
    await expect(handle("write", "notes", "draft", "second")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
