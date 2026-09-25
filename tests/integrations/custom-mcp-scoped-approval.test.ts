import { Hono, type Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import { registerCustomMcpGatewayRoutes } from "../../packages/gateway/src/integrations/custom-mcp/gateway-routes.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import type { CustomMcpServerProjection } from "../../packages/gateway/src/integrations/custom-mcp/types.js";

const serverId = "123e4567-e89b-42d3-a456-426614174000";
const callPath = `/api/mcp-servers/${serverId}/call`;

describe("scoped Custom MCP approval through Gateway and Platform broker", () => {
  it("cannot turn a Claude Run bearer into an always_ask approval while preserving allowed and human calls", async () => {
    const ownerId = "owner_claude";
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: ownerId });
    const capability = registry.issue({ owner: { type: "personal", ownerId }, runId: "run_approval", scope: "call" })!;
    const reviewCapability = registry.issue({
      owner: { type: "personal", ownerId }, runId: "run_review", scope: "discovery",
    })!;
    const tools = [
      { name: "ask", enabled: true, approval: "always_ask" as const },
      { name: "search", enabled: true, approval: "allow" as const },
    ];
    const projection: CustomMcpServerProjection = {
      id: serverId, name: "Public docs fixture", url: "https://docs.example.test/mcp",
      authMode: "none", enabled: true, revision: 10, tools,
    };
    const db = { getCustomMcpServerForBroker: vi.fn(async () => ({
      id: serverId, url: projection.url, auth_mode: "none", encrypted_credentials: null,
      enabled: true, status: "ready", revision: 10, enforcement_projection: tools,
    })) } as unknown as PlatformDb;
    const remoteCall = vi.fn(async () => ({ result: "Synthetic public documentation result" }));
    const broker = new CustomMcpBroker({
      db, encryptionKey: Buffer.alloc(32),
      projection: { upsert: vi.fn(), remove: vi.fn(), read: vi.fn(async () => projection) },
      client: { callTool: remoteCall } as unknown as RemoteMcpClient,
    });
    const platform = createCustomMcpRoutes({ broker, resolveUserId: async () => ownerId, allowToolCalls: true });
    const gateway = new Hono();
    gateway.use("*", authMiddleware("gateway-machine-secret", { resolveMatrixMcpCapability: registry.resolve }));
    const proxyRequest = vi.fn(async (context: Context, _base: string, _prefix: "/api/mcp-servers", token: string) => {
      expect(token).toBe("platform-machine-secret");
      return platform.request(context.req.path.slice("/api/mcp-servers".length), {
        method: context.req.method,
        headers: { "content-type": context.req.header("content-type") ?? "application/json", authorization: `Bearer ${token}` },
        body: await context.req.text(),
      });
    });
    registerCustomMcpGatewayRoutes(gateway, {
      homePath: "/tmp/matrix-custom-mcp-approval-fixture",
      platformProxy: {
        internalPlatformUrl: "https://platform.example.test", handle: "owner",
        token: "platform-machine-secret", request: proxyRequest,
      },
    });
    const scopedHeaders = { authorization: `Bearer ${capability.token}`, "content-type": "application/json" };
    const post = (body: string, headers = scopedHeaders) => gateway.request(callPath, { method: "POST", headers, body });

    expect((await post(JSON.stringify({ tool: "ask", approvalGranted: true }))).status).toBe(403);
    expect(remoteCall).not.toHaveBeenCalled();
    expect((await post(JSON.stringify({ tool: "search", approvalGranted: true }))).status).toBe(403);
    expect(remoteCall).not.toHaveBeenCalled();
    expect((await post(JSON.stringify({ tool: "search", approvalGranted: false }))).status).toBe(200);
    expect(remoteCall).toHaveBeenCalledOnce();
    expect((await post(JSON.stringify({ tool: "search", approvalGranted: false }), {
      authorization: `Bearer ${reviewCapability.token}`, "content-type": "application/json",
    })).status).toBe(401);
    expect(remoteCall).toHaveBeenCalledOnce();
    for (const raw of [
      '{"tool":"ask","approvalGranted":false,"approvalGranted":true}',
      JSON.stringify({ tool: "ask", approvalGranted: "true" }),
      JSON.stringify({ tool: "ask" }),
    ]) {
      expect((await post(raw)).status).toBe(403);
    }
    expect((await post('{"tool":"ask","approvalGranted":')).status).toBe(400);
    expect((await post(JSON.stringify([{ tool: "ask", approvalGranted: true }]))).status).toBe(400);
    expect((await post(JSON.stringify({ tool: "ask", approvalGranted: false,
      arguments: { approvalGranted: true } }))).status).toBe(404);
    expect((await post("x".repeat(64 * 1024 + 1))).status).toBe(413);
    expect(remoteCall).toHaveBeenCalledOnce();
    expect((await post(JSON.stringify({ tool: "ask", approvalGranted: true }), {
      authorization: "Bearer gateway-machine-secret", "content-type": "application/json",
    })).status).toBe(200);
    expect(remoteCall).toHaveBeenCalledTimes(2);
    registry.close();
  });
});
