import { describe, expect, it, vi } from "vitest";
import { tryCreateBrowserServer } from "../../packages/kernel/src/options.js";

const browserServerMocks = vi.hoisted(() => ({
  createBrowserMcpServer: vi.fn((config: unknown) => ({
    name: "matrix-os-browser",
    type: "sdk",
    config,
  })),
}));

vi.mock("@matrix-os/mcp-browser/server", () => ({
  createBrowserMcpServer: browserServerMocks.createBrowserMcpServer,
}));

describe("kernel options", () => {
  it("loads the browser MCP server through ESM import", async () => {
    const server = await tryCreateBrowserServer("/home/matrix", {
      headless: true,
      timeout: 30000,
      idleTimeout: 300000,
      defaultProfile: "default",
    });

    expect(server).toEqual({
      name: "matrix-os-browser",
      type: "sdk",
      config: {
        homePath: "/home/matrix",
        headless: true,
        timeout: 30000,
        idleTimeout: 300000,
        defaultProfile: "default",
      },
    });
    expect(browserServerMocks.createBrowserMcpServer).toHaveBeenCalledTimes(1);
  });
});
