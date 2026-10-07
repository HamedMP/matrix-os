import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createImageClient,
  DEFAULT_ICON_STYLE,
  loadIconStyle,
  buildIconPrompt,
  generateIconBatch,
  type ImageClient,
  type ImageResult,
  createImageStagingCleanup,
  saveGeneratedImage,
} from "../../packages/kernel/src/image-gen.js";

import { png, providerResponse } from "../helpers/image-generation-fixture.js";
import { open, writeFile, utimes, symlink, readdir, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

describe("interrupted image staging cleanup", () => {
  let dir: string;
  beforeEach(() => { dir = resolve(mkdtempSync(join(tmpdir(), "image-staging-"))); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  const temporary = (directory: string) => join(directory, `.matrix-image-${randomUUID()}.tmp`);
  async function stale(path: string) { await writeFile(path, "interrupted bytes"); await utimes(path, new Date(0), new Date(0)); }
  it("recurrently removes stale regular staging files, preserving fresh files, owner data, and symlinks", async () => {
    vi.useFakeTimers();
    const old = temporary(dir), fresh = temporary(dir), owner = join(dir, "owner.png"), alias = temporary(dir);
    await stale(old); await writeFile(fresh, "in progress"); await stale(owner); await symlink(owner, alias);
    const cleanup = createImageStagingCleanup(dir);
    try {
      await cleanup.sweep();
      expect(existsSync(old)).toBe(false); expect(existsSync(fresh)).toBe(true); expect(existsSync(owner)).toBe(true); expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      const later = temporary(dir); await stale(later);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await cleanup.sweep(); expect(existsSync(later)).toBe(false);
      await cleanup.close();
      const afterClose = temporary(dir); await stale(afterClose);
      await vi.advanceTimersByTimeAsync(10 * 60_000); expect(existsSync(afterClose)).toBe(true);
    } finally { await cleanup.close(); }
  });
  it("skips an actively writing staging file even when its timestamp appears stale", async () => {
    const probe = await open(join(dir, "probe"), "wx");
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.writeFile;
    await probe.close();
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(prototype, "writeFile").mockImplementationOnce(async function (this: unknown, ...args: unknown[]) { started(); await blocked; return original.apply(this, args); });
    const saving = saveGeneratedImage(Buffer.from(png, "base64"), "Original icon", { imageDir: dir, saveAs: "saved.png" });
    await writing;
    const name = (await readdir(dir)).find(name => name.startsWith(".matrix-image-"))!;
    await utimes(join(dir, name), new Date(0), new Date(0));
    const cleanup = createImageStagingCleanup(dir);
    try { await cleanup.sweep(); expect(existsSync(join(dir, name))).toBe(true); }
    finally { release(); await saving; await cleanup.close(); }
    expect(readFileSync(join(dir, "saved.png"))).toEqual(Buffer.from(png, "base64"));
    expect(existsSync(join(dir, name))).toBe(false);
  });
  it("bounds each sweep and continues its directory cursor without starving later entries", async () => {
    for (let index = 0; index < 300; index++) await stale(temporary(dir));
    const cleanup = createImageStagingCleanup(dir);
    try {
      await cleanup.sweep(); expect((await readdir(dir)).length).toBeGreaterThan(0);
      for (let index = 0; index < 6; index++) await cleanup.sweep();
      expect(await readdir(dir)).toEqual([]);
    } finally { await cleanup.close(); }
  });
  it("does not sweep through a symbolic-link image directory", async () => {
    const nested = join(dir, "actual"); mkdirSync(nested);
    const old = temporary(nested); await stale(old);
    const alias = join(dir, "alias"); await symlink(nested, alias);
    const cleanup = createImageStagingCleanup(alias);
    try { await cleanup.sweep(); expect(existsSync(old)).toBe(true); }
    finally { await cleanup.close(); }
  });
});

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
    it("uses the real Interactions contract for explicit Nano Banana 2.1 BYOK", async () => {
      const client = createImageClient("owner-key");
      const mockFetch = vi.fn(async () => Response.json(providerResponse()));
      const result = await client.generateImage("Original illustration", { imageDir, saveAs: "new-model.png", model: "gemini-nano-banana-2.1", fetchFn: mockFetch });
      expect(readFileSync(result.localPath)).toEqual(Buffer.from(png, "base64"));
      expect(result.cost).toBe(0.033615);
      expect(mockFetch.mock.calls[0]).toEqual(expect.arrayContaining(["https://generativelanguage.googleapis.com/v1beta/interactions", expect.objectContaining({ headers: expect.objectContaining({ "x-goog-api-key": "owner-key" }) })]));
    });
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

    it("rejects path-like custom saveAs filenames", async () => {
      const client = createImageClient("test-key");
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse());

      await expect(
        client.generateImage("test prompt", {
          imageDir,
          saveAs: "../evil.png",
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("Invalid image filename");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(existsSync(resolve(imageDir, "../evil.png"))).toBe(false);
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

describe("generateIconBatch", () => {
  let imageDir: string;

  beforeEach(() => {
    imageDir = resolve(mkdtempSync(join(tmpdir(), "icon-batch-")));
  });

  afterEach(() => {
    rmSync(imageDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("writes generated app icons using the manifest icon key", async () => {
    const mockFetch = vi.fn().mockResolvedValue(geminiResponse());
    vi.stubGlobal("fetch", mockFetch);

    const result = await generateIconBatch(
      "test-key",
      [{ slug: "pomodoro", icon: "pomodoro-timer", name: "Pomodoro Timer" }],
      "light icon style",
      imageDir,
    );

    expect(result).toEqual({ generated: 1, failed: [] });
    expect(existsSync(join(imageDir, "pomodoro-timer.png"))).toBe(true);
    expect(existsSync(join(imageDir, "pomodoro.png"))).toBe(false);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.contents[0].parts[0].text).toContain("Pomodoro Timer");
  });

  it("keeps slug filenames for legacy string targets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiResponse()));

    await generateIconBatch("test-key", ["calculator"], "light icon style", imageDir);

    expect(existsSync(join(imageDir, "calculator.png"))).toBe(true);
  });

  it("falls back from unsafe manifest icon keys to a safe slug leaf", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiResponse()));

    const result = await generateIconBatch(
      "test-key",
      [{ slug: "games/minesweeper", icon: "../evil", name: "Minesweeper" }],
      "light icon style",
      imageDir,
    );

    expect(result).toEqual({ generated: 1, failed: [] });
    expect(existsSync(join(imageDir, "minesweeper.png"))).toBe(true);
    expect(existsSync(resolve(imageDir, "../evil.png"))).toBe(false);
  });

  it("rejects unsafe string targets instead of writing outside the icon directory", async () => {
    const mockFetch = vi.fn().mockResolvedValue(geminiResponse());
    vi.stubGlobal("fetch", mockFetch);

    const result = await generateIconBatch("test-key", ["../evil"], "light icon style", imageDir);

    expect(result).toEqual({ generated: 0, failed: ["../evil"] });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(existsSync(resolve(imageDir, "../evil.png"))).toBe(false);
  });
});

describe("DEFAULT_ICON_STYLE", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "icon-style-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it("requests an individual tactile icon in the gallery family", () => {
    expect(DEFAULT_ICON_STYLE).toContain("one individual app icon");
    expect(DEFAULT_ICON_STYLE).toContain("matte or satin ceramic and clay");
    expect(DEFAULT_ICON_STYLE).toContain("subtle tactile grain");
    expect(DEFAULT_ICON_STYLE).toContain("one large rounded sculptural object");
    expect(DEFAULT_ICON_STYLE).toContain("pale near-white lavender opaque background");
    expect(DEFAULT_ICON_STYLE).toContain("mist blue, blush, indigo, mint and cream");
    expect(DEFAULT_ICON_STYLE).toContain("soft upper-left studio lighting");
    expect(DEFAULT_ICON_STYLE).toContain("contact shadows");
    expect(DEFAULT_ICON_STYLE).toContain("no text, letters, numbers, logos or watermarks");
    expect(DEFAULT_ICON_STYLE).toContain("Matrix shell owns the final corner radius");
    expect(DEFAULT_ICON_STYLE).toContain("no sprite sheet or grid");
    expect(DEFAULT_ICON_STYLE).not.toMatch(/glossy|glass|plastic|forest|ember/i);
  });

  it("keeps the new-home desktop template identical to the kernel fallback", () => {
    const template = JSON.parse(readFileSync(new URL("../../home/system/desktop.json",import.meta.url),"utf8"));
    expect(template.iconStyle).toBe(DEFAULT_ICON_STYLE);
  });

  it("uses the tactile fallback when the owner has no saved style", async () => {
    expect(loadIconStyle(home)).toBe(DEFAULT_ICON_STYLE);
    mkdirSync(join(home,"system"));
    await writeFile(join(home,"system/desktop.json"),JSON.stringify({ pinnedApps: [] }));
    expect(loadIconStyle(home)).toBe(DEFAULT_ICON_STYLE);
  });

  it("honors the exact saved owner style through the single-icon prompt", async () => {
    const custom = "Owner-selected ink illustration with a coral background";
    mkdirSync(join(home,"system"));
    const configuration = JSON.stringify({ iconStyle: custom, pinnedApps: ["notes"] });
    await writeFile(join(home,"system/desktop.json"),configuration);
    const style = loadIconStyle(home);
    expect(style).toBe(custom);
    expect(buildIconPrompt("trip-companion",style)).toBe(`App icon for 'trip companion': ${custom}, no text, 1:1 square`);
    expect(readFileSync(join(home,"system/desktop.json"),"utf8")).toBe(configuration);
  });

  it("falls back safely on malformed configuration without rewriting owner data", async () => {
    mkdirSync(join(home,"system"));
    await writeFile(join(home,"system/desktop.json"),"{invalid");
    const warning = vi.spyOn(console,"warn").mockImplementation(() => {});
    expect(loadIconStyle(home)).toBe(DEFAULT_ICON_STYLE);
    expect(warning).toHaveBeenCalledOnce();
    expect(readFileSync(join(home,"system/desktop.json"),"utf8")).toBe("{invalid");
  });
});
