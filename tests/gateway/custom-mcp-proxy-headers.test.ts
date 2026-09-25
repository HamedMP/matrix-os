import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { registerCustomMcpGatewayRoutes } from "../../packages/gateway/src/integrations/custom-mcp/gateway-routes.js";
import { proxyIntegrationRequest } from "../../packages/gateway/src/integrations/platform-proxy.js";

afterEach(() => vi.unstubAllGlobals());

describe("production Custom MCP proxy header provenance", () => {
  it("forwards through the mounted route with server-derived Run identity and no caller proof", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" });
    const capability = registry.issue({ owner: { type: "personal", ownerId: "owner" },
      runId: "run_real", scope: "call" })!;
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      url: String(url), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)),
      body: await (init?.body as Blob | undefined)?.text(),
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);
    const app = new Hono();
    app.use("*", authMiddleware("machine-bearer", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    registerCustomMcpGatewayRoutes(app, { homePath: "/unused", platformProxy: {
      internalPlatformUrl: "https://platform.test", handle: "runtime", token: "platform-machine-bearer",
      request: (context, targetBase, routePrefix, token) => proxyIntegrationRequest(context, {
        targetBase, machineToken: token, routePrefix,
      }),
    } });
    const path = "/api/mcp-servers/123e4567-e89b-42d3-a456-426614174000/call";
    const body = JSON.stringify({ toolName: "safe_tool", arguments: {}, approvalGranted: false });
    const request = (token: string) => app.request(path, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "x-matrix-mcp-run-id": "run_forged",
      "x-matrix-custom-mcp-approval-proof": "forged-proof", host: "forged.test",
      "content-type": "application/json",
    }, body });
    const scoped = await request(capability.token);
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toMatchObject({
      url: "https://platform.test/internal/containers/runtime/mcp-servers/123e4567-e89b-42d3-a456-426614174000/call",
      method: "POST", body,
      headers: { authorization: "Bearer platform-machine-bearer", "x-matrix-mcp-run-id": "run_real" },
    });
    const scopedHeaders = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(scopedHeaders.has("x-matrix-custom-mcp-approval-proof")).toBe(false);
    expect(scopedHeaders.has("host")).toBe(false);

    const generic = await request("machine-bearer");
    expect(generic.status).toBe(200);
    const genericHeaders = new Headers(upstream.mock.calls[1]?.[1]?.headers);
    expect(genericHeaders.has("x-matrix-mcp-run-id")).toBe(false);
    expect(genericHeaders.has("x-matrix-custom-mcp-approval-proof")).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(2);
    registry.close();
  });
});
