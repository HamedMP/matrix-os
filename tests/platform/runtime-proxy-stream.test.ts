import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRuntimeProxy } from "../../packages/platform/src/session-routing-middleware.js";
import { Hono } from "hono";
import { runtimeProxyBodyLimit, runtimeProxyBodyLimitBytes } from "../../packages/platform/src/runtime-proxy-fetch.js";
import { MAX_APP_FILE_REQUEST_BYTES } from "../../packages/contracts/src/app-files";

describe("runtime proxy response streaming", () => {
  it.each([
    ["POST", "/api/sync/commit", 300_000],
    ["GET", "/api/sync/commit", 30_000],
    ["POST", "/api/sync/presign", 30_000],
    ["POST", "/api/apps/event/site", 285_000],
    ["GET", "/api/apps/event/site", 30_000],
    ["POST", "/api/apps/event/site/rollback", 30_000],
    ["POST", "/api/apps/invalid!app/site", 30_000],
    // A ten-minute dictation transcribes for longer than the default budget.
    ["POST", "/api/speech/transcriptions", 92_000],
    ["GET", "/api/speech/capabilities", 30_000],
  ])("bounds %s %s with the appropriate operation budget", async (method, path, expected) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    await fetchRuntimeProxy(`https://runtime.invalid${path}`, { method }, 30_000, false);
    expect(timeout).toHaveBeenCalledWith(expected);
  });
  it("forwards a ten-minute dictation upload while every other proxied body keeps the general limit", () => {
    // Fault: the session proxy answered 413 for a recording over 10 MiB before it reached the owner's machine.
    const general = 10 * 1024 * 1024;
    const tenMinuteWav = 600 * 16_000 * 2 + 44;
    for (const path of [
      "/api/speech/transcriptions",
      "/vm/alice/api/speech/transcriptions",
      "/vm/alice/~runtime/studio/api/speech/transcriptions",
    ]) {
      expect(runtimeProxyBodyLimitBytes("POST", path, general)).toBeGreaterThan(tenMinuteWav);
    }
    for (const [method, path] of [
      ["POST", "/api/files/upload"],
      ["PUT", "/api/speech/transcriptions"],
      ["POST", "/api/speech/transcriptions/extra"],
      ["POST", "/vm/alice/extra/api/speech/transcriptions"],
    ] as const) {
      expect(runtimeProxyBodyLimitBytes(method, path, general)).toBe(general);
    }
  });
  it("forwards the save of a 10 MiB document while every other proxied body keeps the general limit", () => {
    // Fault: the session proxy answered 413 for a document save over about 7.5 MiB (base64 in a JSON
    // envelope) before it reached the owner's machine, so a file that opened could never be saved.
    const general = 10 * 1024 * 1024;
    for (const path of [
      "/api/bridge/files",
      "/vm/alice/api/bridge/files",
      "/vm/alice/~runtime/studio/api/bridge/files",
    ]) {
      expect(runtimeProxyBodyLimitBytes("POST", path, general)).toBe(MAX_APP_FILE_REQUEST_BYTES);
    }
    expect(MAX_APP_FILE_REQUEST_BYTES).toBeGreaterThan(general);
    for (const [method, path] of [
      ["POST", "/api/bridge/data"],
      ["POST", "/api/bridge/files/extra"],
      ["PUT", "/api/bridge/files"],
      ["POST", "/vm/alice/extra/api/bridge/files"],
      ["POST", "/api/files/upload"],
    ] as const) {
      expect(runtimeProxyBodyLimitBytes(method, path, general)).toBe(general);
    }
    // Each exception keeps its own bound: a document save never gets the larger dictation limit.
    expect(runtimeProxyBodyLimitBytes("POST", "/api/speech/transcriptions", general)).toBeGreaterThan(MAX_APP_FILE_REQUEST_BYTES);
  });
  it("applies each limit to real request bodies", async () => {
    const general = 1024;
    const app = new Hono();
    app.use("*", runtimeProxyBodyLimit(general));
    app.post("*", async (context) => context.json({ bytes: (await context.req.arrayBuffer()).byteLength }));
    const post = (path: string, bytes: number) => app.request(path, { method: "POST", body: new Uint8Array(bytes) });
    expect((await post("/api/other", general)).status).toBe(200);
    expect((await post("/api/other", general + 1)).status).toBe(413);
    const save = await post("/vm/alice/api/bridge/files", MAX_APP_FILE_REQUEST_BYTES);
    expect(save.status).toBe(200);
    expect(await save.json()).toEqual({ bytes: MAX_APP_FILE_REQUEST_BYTES });
    expect((await post("/api/bridge/files", MAX_APP_FILE_REQUEST_BYTES + 1)).status).toBe(413);
    // The dictation path keeps its own, larger bound.
    expect((await post("/api/speech/transcriptions", MAX_APP_FILE_REQUEST_BYTES + 1)).status).toBe(200);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replays a proxied GET once when its pooled VPS connection was already closed", async () => {
    // Fault: with keep-alive on, a socket the VPS edge dropped surfaced as a 502 for a page load.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stale = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(stale).mockResolvedValueOnce(new Response("shell"));
    const response = await fetchRuntimeProxy("https://runtime.invalid/shared/app/x", { method: "GET" }, 30_000, false);
    expect(await response.text()).toBe("shell");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(stale);
    await expect(fetchRuntimeProxy("https://runtime.invalid/api/files", { method: "POST", body: "{}" }, 30_000, false))
      .rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("still aborts a streaming route if upstream headers never arrive", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const result = fetchRuntimeProxy(
      "https://runtime.invalid/api/chats/events", { method: "GET" }, 10, true,
    ).then(() => "unexpected success", (error: Error) => error.name);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toBe("AbortError");
  });
});
