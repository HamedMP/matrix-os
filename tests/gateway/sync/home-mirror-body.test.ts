import { describe, expect, it, vi } from "vitest";
import { streamToBuffer } from "../../../packages/gateway/src/sync/home-mirror-body.js";

describe("bounded mirror body readers", () => {
  it("aborts a stalled async iterator and requests its cleanup", async () => {
    const controller = new AbortController();
    const finish = vi.fn(async () => ({ done: true as const, value: undefined }));
    const body = { [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => {}), return: finish,
    }) };
    const result = streamToBuffer(body, 1024, controller.signal);
    const observed = result.catch(error => error);
    controller.abort(new Error("synthetic shutdown"));
    const winner = await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("stalled"), 50))]);
    expect(winner).toBe(controller.signal.reason);
    expect(finish).toHaveBeenCalledOnce();
  });
  it("cancels a stalled web reader on abort", async () => {
    const controller = new AbortController(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const observed = streamToBuffer(body, 1024, controller.signal).catch(error => error);
    controller.abort(new Error("synthetic shutdown"));
    expect(await observed).toBe(controller.signal.reason);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
