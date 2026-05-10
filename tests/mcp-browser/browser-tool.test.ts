import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createBrowserTool, type BrowserToolInput } from "../../packages/mcp-browser/src/browser-tool.js";

function createMockPage(url = "https://example.com") {
  const context = {
    pages: vi.fn().mockReturnValue([]),
    newPage: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
  };

  return {
    goto: vi.fn().mockResolvedValue({ status: vi.fn().mockReturnValue(200) }),
    title: vi.fn().mockResolvedValue("Test Page"),
    url: vi.fn().mockReturnValue(url),
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
    route: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockReturnValue(context),
  };
}

function createMockBrowser(page: ReturnType<typeof createMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    contexts: vi.fn().mockReturnValue([]),
  };
}

function createMockRoute(url: string) {
  return {
    request: vi.fn().mockReturnValue({ url: vi.fn().mockReturnValue(url) }),
    continue: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
      resolveHostname: async () => ["93.184.216.34"],
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
      expect(launcher).toHaveBeenCalledWith(expect.objectContaining({
        userDataDir: join(homePath, "data", "browser-profiles", "default"),
      }));
    });

    it("launch starts a named persistent browser profile", async () => {
      const result = await execute({ action: "launch", profile: "work" });
      expect(result.success).toBe(true);
      expect(launcher).toHaveBeenCalledWith(expect.objectContaining({
        userDataDir: join(homePath, "data", "browser-profiles", "work"),
      }));
    });

    it("uses the default profile when later actions omit profile", async () => {
      const defaultPage = createMockPage();
      const defaultBrowser = createMockBrowser(defaultPage);
      launcher.mockResolvedValueOnce(mockBrowser).mockResolvedValueOnce(defaultBrowser);

      await execute({ action: "launch", profile: "work" });
      const result = await execute({ action: "snapshot" });

      expect(result.success).toBe(true);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
      expect(launcher).toHaveBeenLastCalledWith(expect.objectContaining({
        userDataDir: join(homePath, "data", "browser-profiles", "default"),
      }));
    });

    it("rejects invalid profile names before launching", async () => {
      const result = await execute({ action: "launch", profile: "../secret" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid browser profile name");
      expect(launcher).not.toHaveBeenCalled();
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

    it("blocks local browser navigation URLs before launching", async () => {
      const result = await execute({ action: "navigate", url: "http://127.0.0.1:3000" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Browser navigation URL is not allowed");
      expect(launcher).not.toHaveBeenCalled();
    });

    it("auto-launches browser if needed", async () => {
      const result = await execute({ action: "navigate", url: "https://example.com" });
      expect(result.success).toBe(true);
      expect(launcher).toHaveBeenCalled();
    });

    it("installs a request guard before navigation", async () => {
      await execute({ action: "navigate", url: "https://example.com" });
      expect(mockPage.context().route).toHaveBeenCalledWith("**/*", expect.any(Function));
      expect(mockPage.route).not.toHaveBeenCalled();
    });

    it("blocks unsafe requests through the context request guard", async () => {
      await execute({ action: "navigate", url: "https://example.com" });
      const handler = mockPage.context().route.mock.calls[0][1];
      const route = createMockRoute("http://127.0.0.1:3000");

      await handler(route);

      expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
      expect(route.continue).not.toHaveBeenCalled();
    });

    it("falls back to a page request guard when context routing is unavailable", async () => {
      const context = mockPage.context();
      delete (context as { route?: unknown }).route;

      await execute({ action: "navigate", url: "https://example.com" });

      expect(mockPage.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    });

    it("validates every guarded request instead of caching DNS decisions", async () => {
      let resolveCalls = 0;
      const cachedPage = createMockPage();
      const cachedBrowser = createMockBrowser(cachedPage);
      const cachedTool = createBrowserTool({
        homePath,
        launcher: vi.fn().mockResolvedValue(cachedBrowser) as never,
        idleTimeoutMs: 300_000,
        resolveHostname: async () => {
          resolveCalls += 1;
          return ["93.184.216.34"];
        },
      });

      await cachedTool.execute({ action: "launch" });
      const handler = cachedPage.context().route.mock.calls[0][1];
      const routeA = createMockRoute("https://cdn.example/a.js");
      const routeB = createMockRoute("https://cdn.example/b.css");

      await Promise.all([handler(routeA), handler(routeB)]);

      expect(resolveCalls).toBe(2);
      expect(routeA.continue).toHaveBeenCalled();
      expect(routeB.continue).toHaveBeenCalled();
    });
  });

  describe("action serialization", () => {
    it("queues a profile switch until the active action finishes", async () => {
      const personalPage = createMockPage("https://personal.example");
      const personalBrowser = createMockBrowser(personalPage);
      const pendingNavigation = deferred<void>();
      launcher.mockResolvedValueOnce(mockBrowser).mockResolvedValueOnce(personalBrowser);
      mockPage.goto.mockImplementation(async () => {
        await pendingNavigation.promise;
        return { status: vi.fn().mockReturnValue(200) };
      });

      const workNavigate = execute({ action: "navigate", url: "https://example.com", profile: "work" });
      await vi.waitFor(() => expect(mockPage.goto).toHaveBeenCalledTimes(1));

      const personalSnapshot = execute({ action: "snapshot", profile: "personal" });
      await Promise.resolve();

      expect(launcher).toHaveBeenCalledTimes(1);
      pendingNavigation.resolve();
      const [navigateResult, snapshotResult] = await Promise.all([workNavigate, personalSnapshot]);

      expect(navigateResult.success).toBe(true);
      expect(snapshotResult.success).toBe(true);
      expect(launcher).toHaveBeenCalledTimes(2);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
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

    it("saves custom relative artifact paths under screenshots", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "screenshot", path: "runs/page.png" });
      expect(result.success).toBe(true);
      expect(result.screenshotPath).toBe(join(homePath, "data", "screenshots", "runs", "page.png"));
    });

    it("rejects screenshot path traversal", async () => {
      await execute({ action: "launch" });
      const result = await execute({ action: "screenshot", path: "../secret.png" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid browser artifact path");
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

    it("tab_switch updates the active page for later actions", async () => {
      const context = mockPage.context();
      const secondPage = createMockPage("https://second.example");
      secondPage.context.mockReturnValue(context);
      context.pages.mockReturnValue([mockPage, secondPage]);

      await execute({ action: "launch" });
      const result = await execute({ action: "tab_switch", value: "1" });
      const status = await execute({ action: "status" });

      expect(result.success).toBe(true);
      expect(status.content).toContain("https://second.example");
      expect(secondPage.setDefaultTimeout).toHaveBeenCalled();
    });

    it("tab_close moves the active page to a remaining tab", async () => {
      const context = mockPage.context();
      const secondPage = createMockPage("https://second.example");
      secondPage.context.mockReturnValue(context);
      const pages = [mockPage, secondPage];
      context.pages.mockImplementation(() => pages);
      mockPage.close.mockImplementation(async () => {
        const index = pages.indexOf(mockPage);
        if (index >= 0) pages.splice(index, 1);
      });

      await execute({ action: "launch" });
      const result = await execute({ action: "tab_close", value: "0" });
      const status = await execute({ action: "status" });

      expect(result.success).toBe(true);
      expect(mockPage.close).toHaveBeenCalled();
      expect(status.content).toContain("https://second.example");
      expect(secondPage.setDefaultTimeout).toHaveBeenCalled();
    });

    it("tab_close closes the browser session when the last tab closes", async () => {
      const context = mockPage.context();
      const pages = [mockPage];
      context.pages.mockImplementation(() => pages);
      mockPage.close.mockImplementation(async () => {
        pages.splice(0, 1);
      });

      await execute({ action: "launch" });
      const result = await execute({ action: "tab_close" });
      const status = await execute({ action: "status" });

      expect(result.success).toBe(true);
      expect(status.content).toBe("No active browser session");
      expect(mockBrowser.close).toHaveBeenCalled();
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
