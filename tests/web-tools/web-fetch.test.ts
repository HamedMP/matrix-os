import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createWebFetchTool, type WebFetchResult } from "../../packages/kernel/src/tools/web-fetch.js";
import { WebCache } from "../../packages/kernel/src/tools/web-cache.js";

const SAMPLE_HTML = `<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body>
<nav>Skip me</nav>
<article>
<h1>Hello World</h1>
<p>This is the article content.</p>
</article>
<footer>Skip footer too</footer>
</body></html>`;

const SAMPLE_MARKDOWN = "# Hello World\n\nThis is markdown content.";

function mockFetchResponse(body: string, headers: Record<string, string> = {}, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: () => Promise.resolve(body),
  });
}

describe("createWebFetchTool", () => {
  let cache: WebCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new WebCache({ defaultTtlMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches URL and returns content via readability", async () => {
    const fetcher = mockFetchResponse(SAMPLE_HTML, {
      "content-type": "text/html; charset=utf-8",
    });
    const tool = createWebFetchTool({ cache, fetcher });

    const result = await tool.execute({ url: "https://example.com" });
    expect(result.url).toBe("https://example.com");
    expect(result.content).toContain("Hello World");
    expect(result.extractedVia).toBe("readability");
    expect(result.charCount).toBeGreaterThan(0);
  });

  it("uses Cloudflare markdown when server returns text/markdown", async () => {
    const fetcher = mockFetchResponse(SAMPLE_MARKDOWN, {
      "content-type": "text/markdown",
      "x-markdown-tokens": "42",
    });
    const tool = createWebFetchTool({ cache, fetcher });

    const result = await tool.execute({ url: "https://example.com" });
    expect(result.content).toContain("Hello World");
    expect(result.extractedVia).toBe("cloudflare-markdown");
  });

  it("falls back to readability when content-type is HTML", async () => {
    const fetcher = mockFetchResponse(SAMPLE_HTML, {
      "content-type": "text/html",
    });
    const tool = createWebFetchTool({ cache, fetcher });

    const result = await tool.execute({ url: "https://example.com/page" });
    expect(result.extractedVia).toBe("readability");
    expect(result.content).toContain("Hello World");
  });

  it("returns raw text when readability returns empty", async () => {
    const bareHtml = "<html><body>Just text</body></html>";
    const fetcher = mockFetchResponse(bareHtml, {
      "content-type": "text/html",
    });
    const tool = createWebFetchTool({ cache, fetcher });

    const result = await tool.execute({ url: "https://example.com/bare" });
    expect(result.content).toContain("Just text");
    expect(["readability", "raw"]).toContain(result.extractedVia);
  });

  it("respects maxChars truncation", async () => {
    const longContent = "# Title\n\n" + "x".repeat(100_000);
    const fetcher = mockFetchResponse(longContent, {
      "content-type": "text/markdown",
    });
    const tool = createWebFetchTool({ cache, fetcher });

    const result = await tool.execute({ url: "https://example.com", maxChars: 500 });
    expect(result.charCount).toBeLessThanOrEqual(500);
    expect(result.content.length).toBeLessThanOrEqual(500);
  });

  it("returns extractedVia indicator", async () => {
    const fetcher = mockFetchResponse(SAMPLE_MARKDOWN, {
      "content-type": "text/markdown",
    });
    const tool = createWebFetchTool({ cache, fetcher });

    const result = await tool.execute({ url: "https://example.com" });
    expect(result.extractedVia).toBe("cloudflare-markdown");
  });

  it("throws on invalid URL", async () => {
    const fetcher = mockFetchResponse("");
    const tool = createWebFetchTool({ cache, fetcher });

    await expect(tool.execute({ url: "not-a-url" })).rejects.toThrow();
  });

  it("throws on non-http URL", async () => {
    const fetcher = mockFetchResponse("");
    const tool = createWebFetchTool({ cache, fetcher });

    await expect(tool.execute({ url: "file:///etc/passwd" })).rejects.toThrow();
    await expect(tool.execute({ url: "data:text/html,<h1>hi</h1>" })).rejects.toThrow();
  });

  it("returns cached content on cache hit", async () => {
    const fetcher = mockFetchResponse(SAMPLE_MARKDOWN, {
      "content-type": "text/markdown",
    });
    const tool = createWebFetchTool({ cache, fetcher });

    const result1 = await tool.execute({ url: "https://example.com" });
    const result2 = await tool.execute({ url: "https://example.com" });
    expect(result1.content).toBe(result2.content);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("wraps content with external content markers", async () => {
    const fetcher = mockFetchResponse(SAMPLE_MARKDOWN, {
      "content-type": "text/markdown",
    });
    const tool = createWebFetchTool({ cache, fetcher, wrapContent: true });

    const result = await tool.execute({ url: "https://example.com" });
    expect(result.content).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("handles fetch errors gracefully", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Network error"));
    const tool = createWebFetchTool({ cache, fetcher });

    await expect(tool.execute({ url: "https://example.com" })).rejects.toThrow("Network error");
  });

  it("handles non-ok HTTP responses", async () => {
    const fetcher = mockFetchResponse("Not Found", { "content-type": "text/html" }, 404);
    const tool = createWebFetchTool({ cache, fetcher });

    await expect(tool.execute({ url: "https://example.com/missing" })).rejects.toThrow("404");
  });
});
