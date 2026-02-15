import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  createBrowserService,
  type BrowserService,
  type BrowserConfig,
} from "../../packages/mcp-browser/src/browser.js";

describe("T690: Browser automation service", () => {
  let homePath: string;
  let config: BrowserConfig;
  let mockPage: Record<string, unknown>;
  let mockBrowser: Record<string, unknown>;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "browser-test-")));
    mkdirSync(join(homePath, "data", "screenshots"), { recursive: true });
    config = { homePath, headless: true, timeout: 5000 };

    mockPage = {
      goto: vi.fn().mockResolvedValue({ status: vi.fn().mockReturnValue(200) }),
      title: vi.fn().mockResolvedValue("Test Page"),
      url: vi.fn().mockReturnValue("https://example.com"),
      content: vi.fn().mockResolvedValue("<html><body>Hello world</body></html>"),
      textContent: vi.fn().mockResolvedValue("Hello world"),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
      $eval: vi.fn().mockResolvedValue("Selected text"),
      evaluate: vi.fn().mockResolvedValue("Full page text content here"),
      setDefaultTimeout: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("navigate", () => {
    it("navigates to URL and returns page info", async () => {
      const svc = createBrowserService(config, mockBrowser as never);
      const result = await svc.navigate("https://example.com");

      expect(result.title).toBe("Test Page");
      expect(result.url).toBe("https://example.com");
      expect(result.status).toBe(200);
      expect(typeof result.text).toBe("string");
      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "domcontentloaded" });
    });

    it("truncates text to 2000 chars", async () => {
      const longText = "x".repeat(5000);
      (mockPage.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(longText);
      const svc = createBrowserService(config, mockBrowser as never);
      const result = await svc.navigate("https://example.com");

      expect(result.text.length).toBeLessThanOrEqual(2000);
    });

    it("handles navigation errors", async () => {
      (mockPage.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
      const svc = createBrowserService(config, mockBrowser as never);

      await expect(svc.navigate("https://invalid.example")).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
    });
  });

  describe("screenshot", () => {
    it("captures screenshot and saves to file", async () => {
      const svc = createBrowserService(config, mockBrowser as never);
      const result = await svc.screenshot("https://example.com");

      expect(result.path).toContain("screenshots");
      expect(result.path).toMatch(/\.png$/);
      expect(mockPage.screenshot).toHaveBeenCalled();
    });

    it("uses custom filename when provided", async () => {
      const svc = createBrowserService(config, mockBrowser as never);
      const result = await svc.screenshot("https://example.com", { saveAs: "my-shot" });

      expect(result.path).toContain("my-shot.png");
    });
  });

  describe("extract", () => {
    it("extracts full page text", async () => {
      const svc = createBrowserService(config, mockBrowser as never);
      const result = await svc.extract("https://example.com");

      expect(typeof result.text).toBe("string");
      expect(mockPage.goto).toHaveBeenCalled();
    });

    it("extracts text from specific selector", async () => {
      (mockPage.$eval as ReturnType<typeof vi.fn>).mockResolvedValue("Header text");
      const svc = createBrowserService(config, mockBrowser as never);
      const result = await svc.extract("https://example.com", "h1");

      expect(result.text).toBe("Header text");
      expect(mockPage.$eval).toHaveBeenCalledWith("h1", expect.any(Function));
    });
  });

  describe("search", () => {
    it("searches via DuckDuckGo and returns results", async () => {
      const searchResults = [
        { title: "Result 1", url: "https://r1.com", snippet: "Snippet 1" },
        { title: "Result 2", url: "https://r2.com", snippet: "Snippet 2" },
      ];
      (mockPage.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(searchResults);
      const svc = createBrowserService(config, mockBrowser as never);
      const result = await svc.search("matrix protocol");

      expect(result.results).toBeInstanceOf(Array);
      expect(mockPage.goto).toHaveBeenCalled();
      const gotoCall = (mockPage.goto as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(gotoCall).toContain("duckduckgo.com");
      expect(gotoCall).toContain("matrix+protocol");
    });
  });

  describe("session management", () => {
    it("reuses browser instance across calls", async () => {
      const svc = createBrowserService(config, mockBrowser as never);
      await svc.navigate("https://a.com");
      await svc.navigate("https://b.com");

      expect(mockBrowser.newPage).toHaveBeenCalledTimes(2);
    });

    it("closes browser on shutdown", async () => {
      const svc = createBrowserService(config, mockBrowser as never);
      await svc.navigate("https://example.com");
      await svc.close();

      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });

  describe("graceful degradation", () => {
    it("returns error when no browser instance provided and playwright unavailable", async () => {
      const svc = createBrowserService(config, null as never);

      await expect(svc.navigate("https://example.com")).rejects.toThrow(/browser.*not available/i);
    });
  });
});
