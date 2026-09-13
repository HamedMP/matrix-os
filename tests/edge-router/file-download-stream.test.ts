import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEdgeRouterRequest, UPSTREAM_TIMEOUT_MS } from "../../packages/edge-router/src/index";
const env = { EDGE_ROUTER_SECRET: "test-secret", PLATFORM_ORIGIN: "https://platform.example.com" };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("edge file-download streaming", () => {
  it.each(["/api/files/media", "/vm/review/~runtime/preview/api/files/media"])("keeps a healthy attachment body alive after headers on %s", async (path) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    let signal!: AbortSignal;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_req, options) => {
      signal = options!.signal!;
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        setTimeout(() => { if (!signal.aborted) { controller.enqueue(new Uint8Array([9])); controller.close(); } }, UPSTREAM_TIMEOUT_MS + 5_000);
      } }));
    });
    const response = await handleEdgeRouterRequest(new Request(`https://app.matrix-os.com${path}?path=large.bin&download=true`), env);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 5_001);
    expect(signal.aborted).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9]));
  });
  it("still bounds waiting for download headers", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_req, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason))));
    const pending = handleEdgeRouterRequest(new Request("https://app.matrix-os.com/api/files/media?path=file&download=true"), env);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1);
    expect((await pending).status).toBe(504);
  });
});
