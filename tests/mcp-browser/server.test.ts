import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMcpServer } from "../../packages/mcp-browser/src/server.js";

const playwrightMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  launchPersistentContext: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: playwrightMocks.launch,
    launchPersistentContext: playwrightMocks.launchPersistentContext,
  },
}));

describe("Browser MCP server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an MCP server with browser tool", () => {
    const server = createBrowserMcpServer({
      homePath: "/tmp/test",
      headless: true,
      timeout: 5000,
    });

    expect(server).toBeDefined();
    expect(typeof server).toBe("object");
  });

  it("blocks service workers in persistent browser contexts", async () => {
    let page: {
      setDefaultTimeout: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      context: ReturnType<typeof vi.fn>;
    };
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
      route: vi.fn(async () => undefined),
    };
    page = {
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      context: vi.fn(() => context),
    };
    playwrightMocks.launchPersistentContext.mockResolvedValue(context);

    const server = createBrowserMcpServer({
      homePath: "/tmp/test",
      headless: true,
      timeout: 5000,
    });
    const registered = server.instance as unknown as {
      _registeredTools: {
        browser: {
          handler(input: { action: string }): Promise<unknown>;
        };
      };
    };

    await registered._registeredTools.browser.handler({ action: "launch" });

    expect(playwrightMocks.launchPersistentContext).toHaveBeenCalledWith(
      "/tmp/test/data/browser-profiles/default",
      expect.objectContaining({
        headless: true,
        serviceWorkers: "block",
      }),
    );
  });

  it("shares a single browser tool during concurrent cold starts", async () => {
    let page: {
      setDefaultTimeout: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      context: ReturnType<typeof vi.fn>;
    };
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
      route: vi.fn(async () => undefined),
    };
    page = {
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      context: vi.fn(() => context),
    };
    playwrightMocks.launchPersistentContext.mockResolvedValue(context);

    const server = createBrowserMcpServer({
      homePath: "/tmp/test",
      headless: true,
      timeout: 5000,
    });
    const registered = server.instance as unknown as {
      _registeredTools: {
        browser: {
          handler(input: { action: string }): Promise<unknown>;
        };
      };
    };

    await Promise.all([
      registered._registeredTools.browser.handler({ action: "launch" }),
      registered._registeredTools.browser.handler({ action: "launch" }),
    ]);

    expect(playwrightMocks.launchPersistentContext).toHaveBeenCalledTimes(1);
  });
});
