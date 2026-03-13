import { describe, it, expect, vi } from "vitest";
import {
  createEmbeddingService,
  cosineSimilarity,
  loadEmbeddingConfig,
  type EmbeddingService,
} from "../../packages/kernel/src/embeddings.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("embedding service", () => {
  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const v = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([0, 1]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    it("returns -1 for opposite vectors", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([-1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    it("returns 0 for zero vectors", () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });

    it("handles normalized vectors correctly", () => {
      const a = new Float32Array([0.6, 0.8]);
      const b = new Float32Array([0.8, 0.6]);
      const expected = (0.6 * 0.8 + 0.8 * 0.6) / (1.0 * 1.0);
      expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
    });
  });

  describe("createEmbeddingService", () => {
    it("creates service with mock fetch for testing", () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array.from({ length: 256 }, () => Math.random()) }],
          }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });
      expect(service).toBeDefined();
      expect(service.embed).toBeInstanceOf(Function);
      expect(service.embedBatch).toBeInstanceOf(Function);
      expect(service.dimensions).toBe(256);
    });

    it("generates embeddings via API call", async () => {
      const fakeEmbedding = Array.from({ length: 256 }, () => Math.random());
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: fakeEmbedding }] }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });
      const result = await service.embed("hello world");
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(256);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toBe("Bearer test-key");
      const body = JSON.parse(opts.body);
      expect(body.model).toBe("text-embedding-3-small");
      expect(body.dimensions).toBe(256);
      expect(body.input).toEqual(["hello world"]);
    });

    it("supports batch embedding", async () => {
      const fakeEmbedding = Array.from({ length: 256 }, () => Math.random());
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: fakeEmbedding }, { embedding: fakeEmbedding }],
          }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });
      const results = await service.embedBatch(["hello", "world"]);
      expect(results.length).toBe(2);
      expect(results[0]).toBeInstanceOf(Float32Array);
      expect(results[1]).toBeInstanceOf(Float32Array);
    });

    it("returns empty array for empty batch", async () => {
      const mockFetch = vi.fn();
      const service = createEmbeddingService({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });
      const results = await service.embedBatch([]);
      expect(results).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws on missing API key", () => {
      expect(() => createEmbeddingService({ apiKey: "" })).toThrow(
        "Embedding API key required",
      );
    });

    it("throws on API error response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const service = createEmbeddingService({
        apiKey: "bad-key",
        fetchFn: mockFetch,
      });
      await expect(service.embed("hello")).rejects.toThrow("Embedding API error: 401");
    });

    it("uses custom model and dimensions", async () => {
      const fakeEmbedding = Array.from({ length: 512 }, () => Math.random());
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: fakeEmbedding }] }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        model: "text-embedding-3-large",
        dimensions: 512,
        fetchFn: mockFetch,
      });
      expect(service.dimensions).toBe(512);
      await service.embed("test");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("text-embedding-3-large");
      expect(body.dimensions).toBe(512);
    });

    it("uses custom base URL", async () => {
      const fakeEmbedding = Array.from({ length: 256 }, () => Math.random());
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: fakeEmbedding }] }),
      });

      const service = createEmbeddingService({
        apiKey: "test-key",
        baseUrl: "https://custom.api.com/v1",
        fetchFn: mockFetch,
      });
      await service.embed("test");

      expect(mockFetch.mock.calls[0][0]).toBe("https://custom.api.com/v1/embeddings");
    });
  });

  describe("loadEmbeddingConfig", () => {
    let home: string;

    beforeEach(() => {
      home = resolve(mkdtempSync(join(tmpdir(), "embed-config-")));
      mkdirSync(join(home, "system"), { recursive: true });
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      delete process.env.OPENAI_API_KEY;
    });

    it("returns config from config.json", () => {
      writeFileSync(
        join(home, "system", "config.json"),
        JSON.stringify({
          tools: {
            embeddings: {
              openai_key: "sk-from-config",
              model: "text-embedding-3-small",
              dimensions: 256,
            },
          },
        }),
      );

      const config = loadEmbeddingConfig(home);
      expect(config).not.toBeNull();
      expect(config!.apiKey).toBe("sk-from-config");
    });

    it("falls back to OPENAI_API_KEY env var", () => {
      writeFileSync(
        join(home, "system", "config.json"),
        JSON.stringify({ tools: {} }),
      );
      process.env.OPENAI_API_KEY = "sk-from-env";

      const config = loadEmbeddingConfig(home);
      expect(config).not.toBeNull();
      expect(config!.apiKey).toBe("sk-from-env");
    });

    it("returns null when no key available", () => {
      writeFileSync(
        join(home, "system", "config.json"),
        JSON.stringify({ tools: {} }),
      );

      const config = loadEmbeddingConfig(home);
      expect(config).toBeNull();
    });

    it("returns null when config.json missing", () => {
      const config = loadEmbeddingConfig(home);
      expect(config).toBeNull();
    });

    it("ignores empty openai_key in config", () => {
      writeFileSync(
        join(home, "system", "config.json"),
        JSON.stringify({
          tools: { embeddings: { openai_key: "" } },
        }),
      );

      const config = loadEmbeddingConfig(home);
      expect(config).toBeNull();
    });
  });
});
