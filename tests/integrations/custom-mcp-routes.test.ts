import { describe, expect, it, vi } from "vitest";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import type { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";

function broker() {
  return {
    list: vi.fn(async () => []),
    describe: vi.fn(), create: vi.fn(), patch: vi.fn(), remove: vi.fn(),
    discover: vi.fn(), test: vi.fn(), callSelectedTool: vi.fn(),
  } as unknown as CustomMcpBroker;
}

describe("Custom MCP HTTP boundary", () => {
  it("checks owner identity before revealing whether an id exists", async () => {
    const service = broker();
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => null });
    const response = await app.request("/5f03d43b-bbc4-47f0-97d2-a281cf15c4c3");
    expect(response.status).toBe(401);
    expect(service.describe).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and credentials for no-auth servers", async () => {
    const app = createCustomMcpRoutes({ broker: broker(), resolveUserId: async () => "owner" });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docs", url: "https://mcp.acme.tools/mcp", authMode: "none", credential: "secret" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns a generic client error for a broker-rejected URL", async () => {
    const service = broker();
    // Use the actual error class shape so no URL details escape the boundary.
    const { CustomMcpBrokerError } = await import("../../packages/gateway/src/integrations/custom-mcp/broker.js");
    vi.mocked(service.create).mockRejectedValueOnce(new CustomMcpBrokerError("invalid"));
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => "owner" });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", url: "http://127.0.0.1/mcp", authMode: "none" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Custom MCP request" });
  });

  it("does not expose the broker call route on public route sets", async () => {
    const service = broker();
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => "owner" });
    const response = await app.request("/5f03d43b-bbc4-47f0-97d2-a281cf15c4c3/call", { method: "POST" });
    expect(response.status).toBe(404);
    expect(service.callSelectedTool).not.toHaveBeenCalled();
  });
});
