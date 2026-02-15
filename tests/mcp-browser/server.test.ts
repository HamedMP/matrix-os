import { describe, it, expect } from "vitest";

import { createBrowserMcpServer } from "../../packages/mcp-browser/src/server.js";

describe("T691: Browser MCP server", () => {
  it("creates an MCP server with browse_web tool", () => {
    const server = createBrowserMcpServer({
      homePath: "/tmp/test",
      headless: true,
      timeout: 5000,
    });

    expect(server).toBeDefined();
    expect(typeof server).toBe("object");
  });
});
