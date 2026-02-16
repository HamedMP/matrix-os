import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createWebSearchTool, type WebSearchResult } from "../../packages/kernel/src/tools/web-search.js";
import { WebCache } from "../../packages/kernel/src/tools/web-cache.js";

describe("createWebSearchTool", () => {
  let cache: WebCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new WebCache({ defaultTtlMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Brave Search", () => {
    it("returns structured results", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          web: {
            results: [
              { title: "Matrix Protocol", url: "https://matrix.org", description: "A decentralized protocol", age: "2d" },
              { title: "Matrix Spec", url: "https://spec.matrix.org", description: "The specification", age: "5d" },
            ],
          },
        }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { brave: "test-key" } });
      const result = await tool.execute({ query: "matrix protocol", provider: "brave" });

      expect(result.provider).toBe("brave");
      expect(result.results).toHaveLength(2);
      expect(result.results[0].title).toBe("Matrix Protocol");
      expect(result.results[0].url).toBe("https://matrix.org");
      expect(result.results[0].snippet).toBe("A decentralized protocol");
    });

    it("maps freshness parameter correctly", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { brave: "test-key" } });
      await tool.execute({ query: "news", provider: "brave", freshness: "day" });

      const url = fetcher.mock.calls[0][0] as string;
      expect(url).toContain("freshness=pd");
    });

    it("sends correct auth header", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { brave: "my-brave-key" } });
      await tool.execute({ query: "test", provider: "brave" });

      const opts = fetcher.mock.calls[0][1] as RequestInit;
      expect((opts.headers as Record<string, string>)["X-Subscription-Token"]).toBe("my-brave-key");
    });

    it("respects count parameter", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { brave: "test-key" } });
      await tool.execute({ query: "test", provider: "brave", count: 3 });

      const url = fetcher.mock.calls[0][0] as string;
      expect(url).toContain("count=3");
    });
  });

  describe("Perplexity Search", () => {
    it("returns conversational answer with citations", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: "Matrix is a decentralized protocol [1].",
            },
          }],
          citations: ["https://matrix.org"],
        }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { perplexity: "pplx-test" } });
      const result = await tool.execute({ query: "what is matrix", provider: "perplexity" });

      expect(result.provider).toBe("perplexity");
      expect(result.answer).toContain("Matrix is a decentralized protocol");
    });

    it("detects OpenRouter prefix for routing", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: "answer" } }],
        }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { perplexity: "sk-or-test" } });
      await tool.execute({ query: "test", provider: "perplexity" });

      const url = fetcher.mock.calls[0][0] as string;
      expect(url).toContain("openrouter.ai");
    });

    it("uses direct API for pplx- prefix", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: "answer" } }],
        }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { perplexity: "pplx-test" } });
      await tool.execute({ query: "test", provider: "perplexity" });

      const url = fetcher.mock.calls[0][0] as string;
      expect(url).toContain("perplexity.ai");
    });
  });

  describe("Grok Search", () => {
    it("returns structured answer", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: "Matrix OS is a unified AI operating system.",
            },
          }],
        }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { grok: "xai-test" } });
      const result = await tool.execute({ query: "what is matrix os", provider: "grok" });

      expect(result.provider).toBe("grok");
      expect(result.answer).toContain("Matrix OS");
    });
  });

  describe("Provider auto-detection", () => {
    it("picks brave when available", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { brave: "key", perplexity: "key2" } });
      const result = await tool.execute({ query: "test" });
      expect(result.provider).toBe("brave");
    });

    it("falls back to perplexity when no brave key", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: "answer" } }],
        }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { perplexity: "pplx-key" } });
      const result = await tool.execute({ query: "test" });
      expect(result.provider).toBe("perplexity");
    });

    it("returns error when no API keys configured", async () => {
      const fetcher = vi.fn();
      const tool = createWebSearchTool({ cache, fetcher, apiKeys: {} });

      await expect(tool.execute({ query: "test" })).rejects.toThrow(/no.*api.*key/i);
    });
  });

  describe("Caching", () => {
    it("returns cached results without re-fetching", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { brave: "key" } });
      await tool.execute({ query: "test", provider: "brave" });
      await tool.execute({ query: "test", provider: "brave" });

      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("Error handling", () => {
    it("handles API errors gracefully", async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const tool = createWebSearchTool({ cache, fetcher, apiKeys: { brave: "key" } });
      await expect(tool.execute({ query: "test", provider: "brave" })).rejects.toThrow("429");
    });
  });
});
