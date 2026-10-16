import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { resolve4 } from "node:dns/promises";
import { createWebFetchTool } from "../../packages/kernel/src/tools/web-fetch.js";
import { WebCache } from "../../packages/kernel/src/tools/web-cache.js";

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
  resolve6: vi.fn().mockResolvedValue([]),
}));

const url = "https://example.com/article";
const markdownHeaders = { "content-type": "text/markdown" };
const bytes = (value: string) => new TextEncoder().encode(value);

function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = markdownHeaders, status = 200) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers, status }), cancel, body };
}

describe("web fetch response limits", () => {
  let cache: WebCache;

  beforeEach(() => { cache = new WebCache({ defaultTtlMs: 60_000 }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("rejects an oversized chunk before extraction and never caches it", async () => {
    const { response, cancel, body } = streamedResponse([bytes("x".repeat(65))]);
    const tool = createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(response), maxResponseBytes: 64 });
    await expect(tool.execute({ url, maxChars: 1 })).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(cache.get(`fetch:${WebCache.normalizeUrl(url)}`)).toBeUndefined();
  });

  it("counts accumulated UTF-8 bytes and accepts exactly the byte cap", async () => {
    const { response, body } = streamedResponse([bytes("éé"), bytes("éé")]);
    const result = await createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(response), maxResponseBytes: 8 }).execute({ url });
    expect(result.content).toBe("éééé");
    expect(body.locked).toBe(false);
    const oversized = streamedResponse([bytes("éé"), bytes("ééé")]);
    await expect(createWebFetchTool({ cache: new WebCache(), fetcher: vi.fn().mockResolvedValue(oversized.response), maxResponseBytes: 8 }).execute({ url })).rejects.toThrow("byte limit");
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });

  it("preserves UTF-8 characters split across streamed chunks", async () => {
    const encoded = bytes("Hello 🌍");
    const { response } = streamedResponse([encoded.subarray(0, 8), encoded.subarray(8)]);
    const result = await createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(response) }).execute({ url });
    expect(result.content).toBe("Hello 🌍");
  });

  it("caps decompressed bytes regardless of Content-Length", async () => {
    const compressed = gzipSync("x".repeat(4096));
    const body = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const response = new Response(body, { headers: { ...markdownHeaders, "content-encoding": "gzip", "content-length": String(compressed.length) } });
    await expect(createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(response), maxResponseBytes: 256 }).execute({ url })).rejects.toThrow("byte limit");
    expect(body.locked).toBe(false);
  });

  it("times out a never-ending body, cancels it and releases its reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes("start")); }, cancel });
    const response = new Response(body, { headers: markdownHeaders });
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(createWebFetchTool({ cache, fetcher, timeoutMs: 40 }).execute({ url })).rejects.toThrow("deadline");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not let a hanging cancel hook extend the deadline", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: markdownHeaders });
    await expect(createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(response), timeoutMs: 40 }).execute({ url })).rejects.toThrow("deadline");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("uses one deadline across redirect hops instead of resetting it", async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const responses: Response[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      await new Promise((resolve) => setTimeout(resolve, 35));
      const response = new Response("redirect", { status: 302, headers: { location: `/hop-${++calls}` } });
      responses.push(response);
      return response;
    });
    await expect(createWebFetchTool({ cache, fetcher, timeoutMs: 55 }).execute({ url })).rejects.toThrow("deadline");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it("cancels error and redirect response bodies without reading them", async () => {
    const failed = streamedResponse([], markdownHeaders, 404);
    await expect(createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(failed.response) }).execute({ url })).rejects.toThrow("404");
    expect(failed.cancel).toHaveBeenCalledOnce();
    const redirect = streamedResponse([], { location: "/final" }, 302);
    const fetcher = vi.fn().mockResolvedValueOnce(redirect.response).mockResolvedValueOnce(new Response("ok", { headers: markdownHeaders }));
    await expect(createWebFetchTool({ cache, fetcher }).execute({ url })).resolves.toMatchObject({ content: "ok" });
    expect(redirect.cancel).toHaveBeenCalledOnce();
  });

  it("cancels and unlocks a body when reading fails", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("read failed")); } });
    await expect(createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(new Response(body)) }).execute({ url })).rejects.toThrow("read failed");
    expect(body.locked).toBe(false);
  });

  it("bounds the Firecrawl response before JSON parsing", async () => {
    const fallback = streamedResponse([bytes(JSON.stringify({ data: { markdown: "x".repeat(300) } }))], { "content-type": "application/json" });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("<html></html>")).mockResolvedValueOnce(fallback.response);
    await expect(createWebFetchTool({ cache, fetcher, firecrawlApiKey: "test-key", maxResponseBytes: 128 }).execute({ url })).rejects.toThrow("byte limit");
    expect(fallback.cancel).toHaveBeenCalledOnce();
    expect(fallback.body.locked).toBe(false);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });

  it("applies the original deadline to Firecrawl body reading", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("<html></html>")).mockResolvedValueOnce(new Response(body));
    await expect(createWebFetchTool({ cache, fetcher, firecrawlApiKey: "test-key", timeoutMs: 150 }).execute({ url })).rejects.toThrow("deadline");
    expect(fetcher.mock.calls[1][1].signal).toBe(fetcher.mock.calls[0][1].signal);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("preserves a bounded Firecrawl extraction and falls back on provider errors", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("<html></html>")).mockResolvedValueOnce(Response.json({ data: { markdown: "# fallback", metadata: { title: "Fallback" } } }));
    await expect(createWebFetchTool({ cache, fetcher, firecrawlApiKey: "test-key" }).execute({ url })).resolves.toMatchObject({ content: "# fallback", title: "Fallback", extractedVia: "firecrawl" });
    const failed = streamedResponse([], markdownHeaders, 503);
    const failingFetcher = vi.fn().mockResolvedValueOnce(new Response("<html></html>")).mockResolvedValueOnce(failed.response);
    await expect(createWebFetchTool({ cache: new WebCache(), fetcher: failingFetcher, firecrawlApiKey: "test-key" }).execute({ url })).resolves.toMatchObject({ extractedVia: "raw" });
    expect(failed.cancel).toHaveBeenCalledOnce();
  });

  it("rejects text-only fetcher responses rather than reading an unbounded body", async () => {
    const text = vi.fn().mockResolvedValue("unbounded");
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(markdownHeaders), text });
    await expect(createWebFetchTool({ cache, fetcher }).execute({ url })).rejects.toThrow("stream");
    expect(text).not.toHaveBeenCalled();
  });

  it("enforces the production byte cap even when maxChars requests a tiny output", async () => {
    const response = new Response("x".repeat(5 * 1024 * 1024 + 1), { headers: markdownHeaders });
    await expect(createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(response) }).execute({ url, maxChars: 1 })).rejects.toThrow("byte limit");
    expect(() => createWebFetchTool({ cache, maxResponseBytes: 5 * 1024 * 1024 + 1 })).toThrow("limit");
    expect(() => createWebFetchTool({ cache, timeoutMs: 30_001 })).toThrow("limit");
  });

  it("times out a fetcher that never settles and handles a late rejection", async () => {
    let rejectFetch!: (reason: Error) => void;
    const fetcher = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
    await expect(createWebFetchTool({ cache, fetcher, timeoutMs: 40 }).execute({ url })).rejects.toThrow("deadline");
    rejectFetch(new Error("late network error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it("spends the same deadline on URL validation before fetching", async () => {
    let finishLookup!: (ips: string[]) => void;
    vi.mocked(resolve4).mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
    const fetcher = vi.fn();
    await expect(createWebFetchTool({ cache, fetcher, timeoutMs: 40 }).execute({ url })).rejects.toThrow("deadline");
    finishLookup(["93.184.216.34"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds an uninterrupted stream of empty chunks without waiting for the timer callback", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel });
    await expect(createWebFetchTool({ cache, fetcher: vi.fn().mockResolvedValue(new Response(body)), timeoutMs: 40 }).execute({ url })).rejects.toThrow("deadline");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([
    "http://[::ffff:127.0.0.1]/admin",
    "http://[::ffff:10.0.0.1]/admin",
    "http://[::ffff:169.254.169.254]/admin",
  ])("blocks mapped-private URL %s before any fetch", async (target) => {
    const fetcher = vi.fn();
    await expect(createWebFetchTool({ cache, fetcher }).execute({ url: target })).rejects.toThrow("SSRF blocked");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::ffff:7f00:1]/admin",
    "http://[::ffff:a00:1]/admin",
    "http://[::ffff:a9fe:a9fe]/admin",
  ])("blocks redirect to mapped-private URL %s and cancels the redirect body", async (target) => {
    const redirect = streamedResponse([], { location: target }, 302);
    const fetcher = vi.fn().mockResolvedValueOnce(redirect.response);
    await expect(createWebFetchTool({ cache, fetcher }).execute({ url })).rejects.toThrow("SSRF blocked");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(redirect.cancel).toHaveBeenCalledOnce();
    expect(redirect.body.locked).toBe(false);
  });
});
