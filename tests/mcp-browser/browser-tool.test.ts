import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createBrowserTool, type BrowserToolInput } from "../../packages/mcp-browser/src/browser-tool.js";

function createMockPage() {
  return {
    goto: vi.fn().mockResolvedValue({ status: vi.fn().mockReturnValue(200) }),
    title: vi.fn().mockResolvedValue("Test Page"),
    url: vi.fn().mockReturnValue("https://example.com"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    pdf: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
    content: vi.fn().mockResolvedValue("<html><body>Hello</body></html>"),
    evaluate: vi.fn().mockResolvedValue("result"),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    getByRole: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(undefined) }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    setDefaultTimeout: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    accessibility: {
      snapshot: vi.fn().mockResolvedValue({
        role: "document",
        name: "Test Page",
        children: [
          { role: "heading", name: "Hello", level: 1 },
          { role: "textbox", name: "Input", value: "" },
        ],
      }),
    },
    on: vi.fn(),
    context: vi.fn().mockReturnValue({
      pages: vi.fn().mockReturnValue([]),
      newPage: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function createMockBrowser(page: ReturnType<typeof createMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    contexts: vi.fn().mockReturnValue([]),
  };
}

describe("Browser Tool (composite action dispatch)", () => {
  let homePath: string;
  let mockPage: ReturnType<typeof createMockPage>;
  let mockBrowser: ReturnType<typeof createMockBrowser>;
  let launcher: ReturnType<typeof vi.fn>;
  let execute: (input: BrowserToolInput) => Promise<{ action: string; success: boolean; [k: string]: unknown }>;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "browser-tool-")));
    mkdirSync(join(homePath, "data", "screenshots"), { recursive: true });

    mockPage = createMockPage();
    mockBrowser = createMockBrowser(mockPage);
    launcher = vi.fn().mockResolvedValue(mockBrowser);

    const tool = createBrowserTool({
      homePath,
      launcher: launcher as never,
      idleTimeoutMs: 300_000,
    });
    execute = tool.execute;
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("launch + close + status", () => {
    it("launch starts browser session", async () => {
      const result = await execute({ action: "launch" });
      expect(result.success).toBe(true);
      expect(result.action).toBe("launch");
    });

    it("close shuts down browser", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "close" });
      expect(result.success).toBe(true);
    });

    it("status returns session info", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "status" });
      expect(result.success).toBe(true);
      expect(result.content).toContain("active");
    });
  });

  describe("navigate", () => {
    it("opens URL and returns title", async () => {
      const result = await execute({ action: "navigate", url: "https://example.com" });
      expect(result.success).toBe(true);
      expect(result.title).toBe("Test Page");
      expect(result.url).toBe("https://example.com");
    });

    it("auto-launches browser if needed", async () => {
      const result = await execute({ action: "navigate", url: "https://example.com" });
      expect(result.success).toBe(true);
      expect(launcher).toHaveBeenCalled();
    });
  });

  describe("snapshot", () => {
    it("returns accessibility tree", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "snapshot" });
      expect(result.success).toBe(true);
      expect(result.content).toContain("document");
      expect(result.content).toContain("Hello");
    });
  });

  describe("click", () => {
    it("clicks element by selector", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "click", selector: "#btn" });
      expect(result.success).toBe(true);
      expect(mockPage.click).toHaveBeenCalledWith("#btn");
    });

    it("clicks element by role and name", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "click", role: "button", name: "Submit" });
      expect(result.success).toBe(true);
      expect(mockPage.getByRole).toHaveBeenCalledWith("button", { name: "Submit" });
    });
  });

  describe("type", () => {
    it("enters text into input", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "type", selector: "#input", text: "hello" });
      expect(result.success).toBe(true);
      expect(mockPage.fill).toHaveBeenCalledWith("#input", "hello");
    });
  });

  describe("select", () => {
    it("selects option from dropdown", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "select", selector: "#dropdown", value: "opt1" });
      expect(result.success).toBe(true);
      expect(mockPage.selectOption).toHaveBeenCalledWith("#dropdown", "opt1");
    });
  });

  describe("screenshot", () => {
    it("saves file and returns path", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "screenshot" });
      expect(result.success).toBe(true);
      expect(result.screenshotPath).toContain("screenshots");
      expect(result.screenshotPath).toMatch(/\.png$/);
    });
  });

  describe("pdf", () => {
    it("saves page as PDF", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "pdf" });
      expect(result.success).toBe(true);
      expect(result.screenshotPath).toMatch(/\.pdf$/);
    });
  });

  describe("evaluate", () => {
    it("runs JS and returns result", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "evaluate", expression: "1 + 1" });
      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
    });
  });

  describe("wait", () => {
    it("waits for selector", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "wait", selector: "#loading" });
      expect(result.success).toBe(true);
      expect(mockPage.waitForSelector).toHaveBeenCalledWith("#loading", expect.any(Object));
    });
  });

  describe("scroll", () => {
    it("scrolls page", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "scroll" });
      expect(result.success).toBe(true);
    });
  });

  describe("tab management", () => {
    it("tabs lists open tabs", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "tabs" });
      expect(result.success).toBe(true);
    });
  });

  describe("console reading", () => {
    it("returns captured console messages", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "console" });
      expect(result.success).toBe(true);
    });
  });

  describe("unknown action", () => {
    it("returns error for invalid action", async () => {
      const result = await execute({ action: "invalid" as never });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown action");
    });
  });

  describe("external content wrapping", () => {
    it("wraps snapshot output with markers", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "snapshot" });
      expect(result.content).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    });

    it("wraps evaluate output with markers", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "evaluate", expression: "document.title" });
      expect(result.content).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    });
  });
});
