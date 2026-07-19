import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRuntimeProxy } from "../../packages/platform/src/session-routing-middleware.js";

describe("runtime proxy response streaming", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the upstream timeout after media response headers arrive", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("complete media"));
            controller.close();
          }, 50);
        },
      }));
    });

    const response = await fetchRuntimeProxy(
      "https://runtime.invalid/api/files/media?path=movie.mp4",
      { method: "GET" },
      10,
      true,
    );
    await vi.advanceTimersByTimeAsync(50);

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
    expect(await response.text()).toBe("complete media");
  });
});
