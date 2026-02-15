import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createImageClient,
  type ImageClient,
  type ImageResult,
} from "../../packages/kernel/src/image-gen.js";

const fakeImageBuffer = Buffer.from("fake-png-data");

describe("Image Generation Client", () => {
  let imageDir: string;

  beforeEach(() => {
    imageDir = resolve(mkdtempSync(join(tmpdir(), "image-gen-")));
  });

  afterEach(() => {
    rmSync(imageDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("createImageClient", () => {
    it("initializes with API key", () => {
      const client = createImageClient("test-key");
      expect(client).toBeDefined();
      expect(typeof client.generateImage).toBe("function");
    });

    it("returns not-configured client when no API key", () => {
      const client = createImageClient("");
      expect(client).toBeDefined();
      expect(client.isConfigured()).toBe(false);
    });

    it("reports configured when API key present", () => {
      const client = createImageClient("test-key");
      expect(client.isConfigured()).toBe(true);
    });
  });

  describe("generateImage", () => {
    it("returns image result with url, localPath, model, cost", async () => {
      const client = createImageClient("test-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          images: [{ url: "https://fal.ai/result/image.png" }],
        }),
      });

      const mockDownload = vi.fn().mockResolvedValue(fakeImageBuffer);

      const result = await client.generateImage("a sunset over mountains", {
        imageDir,
        fetchFn: mockFetch,
        downloadFn: mockDownload,
      });

      expect(result.url).toBe("https://fal.ai/result/image.png");
      expect(result.localPath).toBeDefined();
      expect(result.model).toBe("fal-ai/flux/schnell");
      expect(typeof result.cost).toBe("number");
    });

    it("defaults to flux-schnell model", async () => {
      const client = createImageClient("test-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          images: [{ url: "https://fal.ai/result/image.png" }],
        }),
      });

      await client.generateImage("test prompt", {
        imageDir,
        fetchFn: mockFetch,
        downloadFn: vi.fn().mockResolvedValue(fakeImageBuffer),
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("fal-ai/flux/schnell"),
        expect.any(Object),
      );
    });

    it("allows model selection", async () => {
      const client = createImageClient("test-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          images: [{ url: "https://fal.ai/result/image.png" }],
        }),
      });

      await client.generateImage("test prompt", {
        model: "fal-ai/flux/dev",
        imageDir,
        fetchFn: mockFetch,
        downloadFn: vi.fn().mockResolvedValue(fakeImageBuffer),
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("fal-ai/flux/dev"),
        expect.any(Object),
      );
    });

    it("saves image to specified directory", async () => {
      const client = createImageClient("test-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          images: [{ url: "https://fal.ai/result/image.png" }],
        }),
      });

      const result = await client.generateImage("test prompt", {
        imageDir,
        fetchFn: mockFetch,
        downloadFn: vi.fn().mockResolvedValue(fakeImageBuffer),
      });

      expect(existsSync(result.localPath)).toBe(true);
      expect(readFileSync(result.localPath)).toEqual(fakeImageBuffer);
    });

    it("handles API auth errors", async () => {
      const client = createImageClient("bad-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({ detail: "Invalid API key" }),
      });

      await expect(
        client.generateImage("test", { imageDir, fetchFn: mockFetch }),
      ).rejects.toThrow("API key");
    });

    it("handles rate limit errors", async () => {
      const client = createImageClient("test-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: () => Promise.resolve({ detail: "Rate limited" }),
      });

      await expect(
        client.generateImage("test", { imageDir, fetchFn: mockFetch }),
      ).rejects.toThrow("Rate limit");
    });

    it("returns error when not configured", async () => {
      const client = createImageClient("");

      await expect(
        client.generateImage("test", { imageDir }),
      ).rejects.toThrow("not configured");
    });

    it("supports custom size", async () => {
      const client = createImageClient("test-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          images: [{ url: "https://fal.ai/result/image.png" }],
        }),
      });

      await client.generateImage("test prompt", {
        size: "512x512",
        imageDir,
        fetchFn: mockFetch,
        downloadFn: vi.fn().mockResolvedValue(fakeImageBuffer),
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.image_size).toBe("512x512");
    });
  });
});
