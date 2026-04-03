import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createImageClient,
  type ImageClient,
  type ImageResult,
} from "../../packages/kernel/src/image-gen.js";

const fakeImageBase64 = Buffer.from("fake-png-data").toString("base64");

function geminiResponse(base64 = fakeImageBase64) {
  return {
    ok: true,
    json: () => Promise.resolve({
      candidates: [{
        content: {
          parts: [{
            inlineData: { mimeType: "image/png", data: base64 },
          }],
        },
      }],
    }),
  };
}

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
    it("returns image result with localPath, model, cost", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      const result = await client.generateImage("a sunset over mountains", {
        imageDir,
        fetchFn: mockFetch,
      });

      expect(result.localPath).toBeDefined();
      expect(result.model).toBe("gemini-2.5-flash-image");
      expect(typeof result.cost).toBe("number");
    });

    it("defaults to gemini-2.5-flash-image model", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      await client.generateImage("test prompt", {
        imageDir,
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("gemini-2.5-flash-image"),
        expect.any(Object),
      );
    });

    it("allows model selection", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      await client.generateImage("test prompt", {
        model: "gemini-3.1-flash-image-preview",
        imageDir,
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("gemini-3.1-flash-image-preview"),
        expect.any(Object),
      );
    });

    it("saves image to specified directory", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      const result = await client.generateImage("test prompt", {
        imageDir,
        fetchFn: mockFetch,
      });

      expect(existsSync(result.localPath)).toBe(true);
      expect(readFileSync(result.localPath)).toEqual(Buffer.from(fakeImageBase64, "base64"));
    });

    it("handles API auth errors", async () => {
      const client = createImageClient("bad-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({ error: { message: "Invalid API key" } }),
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
        json: () => Promise.resolve({ error: { message: "Rate limited" } }),
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

    it("sends aspect ratio and image size in request", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      await client.generateImage("test prompt", {
        aspectRatio: "16:9",
        imageSize: "2K",
        imageDir,
        fetchFn: mockFetch,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.generationConfig.imageConfig.aspectRatio).toBe("16:9");
      expect(body.generationConfig.imageConfig.imageSize).toBe("2K");
    });

    it("omits imageConfig when no aspect ratio or size", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      await client.generateImage("test prompt", {
        imageDir,
        fetchFn: mockFetch,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.generationConfig.imageConfig).toBeUndefined();
    });

    it("sends API key in x-goog-api-key header", async () => {
      const client = createImageClient("my-secret-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      await client.generateImage("test", { imageDir, fetchFn: mockFetch });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-goog-api-key"]).toBe("my-secret-key");
    });

    it("throws when model returns no image (safety filter)", async () => {
      const client = createImageClient("test-key");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: "I cannot generate that image." }] } }],
        }),
      });

      await expect(
        client.generateImage("test", { imageDir, fetchFn: mockFetch }),
      ).rejects.toThrow("No image returned");
    });

    it("supports custom saveAs filename", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      const result = await client.generateImage("test prompt", {
        imageDir,
        saveAs: "custom-name.png",
        fetchFn: mockFetch,
      });

      expect(result.localPath).toContain("custom-name.png");
    });

    it("includes abort signal with 30s timeout", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      await client.generateImage("test", { imageDir, fetchFn: mockFetch });

      const fetchOpts = mockFetch.mock.calls[0][1];
      expect(fetchOpts.signal).toBeDefined();
    });
  });
});
