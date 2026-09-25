import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { integrationProxyHeaders } from "../../packages/gateway/src/integrations/custom-mcp/proxy-headers.js";

describe("production Custom MCP proxy header provenance", () => {
  it("overwrites a forged Run header from a live scoped capability and strips it for generic machine callers", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" });
    const capability = registry.issue({ owner: { type: "personal", ownerId: "owner" },
      runId: "run_real", scope: "call" })!;
    const app = new Hono();
    app.use("*", authMiddleware("machine-bearer", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    app.post("/api/mcp-servers/123e4567-e89b-42d3-a456-426614174000/call", context =>
      context.json(Object.fromEntries(integrationProxyHeaders(context, "/api/mcp-servers"))));
    const path = "/api/mcp-servers/123e4567-e89b-42d3-a456-426614174000/call";
    const request = (token: string) => app.request(path, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "x-matrix-mcp-run-id": "run_forged",
      "x-matrix-custom-mcp-approval-proof": "forged-proof", host: "forged.test",
    } });
    expect(await (await request(capability.token)).json()).toMatchObject({ "x-matrix-mcp-run-id": "run_real" });
    expect(await (await request("machine-bearer")).json()).not.toHaveProperty("x-matrix-mcp-run-id");
    expect(await (await request(capability.token)).json()).not.toHaveProperty("x-matrix-custom-mcp-approval-proof");
    registry.close();
  });
});
