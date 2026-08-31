import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerCustomMcpGatewayRoutes } from "../../packages/gateway/src/integrations/custom-mcp/gateway-routes.js";

describe("Custom MCP gateway route composition", () => {
  it("mounts the authenticated projection endpoint", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-mcp-gateway-"));
    const app = new Hono();
    registerCustomMcpGatewayRoutes(app, {
      homePath,
      clerkUserId: "user_123",
      projectionToken: "projection-secret",
    });

    const response = await app.request("/api/internal/mcp-projection", {
      method: "POST",
      headers: {
        authorization: "Bearer projection-secret",
        "content-type": "application/json",
        "x-matrix-clerk-user-id": "user_123",
      },
      body: JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Research",
        url: "https://mcp.acme.tools/mcp",
        authMode: "none",
        enabled: false,
        revision: 1,
        tools: [],
      }),
    });

    expect(response.status).toBe(200);
  });

  it("owns Custom MCP platform-proxy composition outside the gateway entrypoint", async () => {
    const app = new Hono();
    const proxyRequest = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
    registerCustomMcpGatewayRoutes(app, {
      homePath: "/tmp/matrix-custom-mcp-test",
      platformProxy: {
        internalPlatformUrl: "https://app.matrix-os.com",
        handle: "owner",
        token: "host-token",
        request: proxyRequest,
      },
    });

    const response = await app.request("/api/mcp-servers/server-id/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(proxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ req: expect.objectContaining({ path: "/api/mcp-servers/server-id/discover" }) }),
      "https://app.matrix-os.com/internal/containers/owner/mcp-servers",
      "/api/mcp-servers",
      "host-token",
    );
  });
});
