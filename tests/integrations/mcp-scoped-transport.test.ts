import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const serverId = "123e4567-e89b-42d3-a456-426614174000";

describe("scoped Claude-to-Matrix MCP transport", () => {
  it("initializes stdio, forwards list/describe/call through actor-bound Gateway auth, and denies reuse after revoke", async () => {
    const ownerId = "owner_claude";
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: ownerId });
    const capability = registry.issue({ owner: { type: "personal", ownerId }, runId: "run_fixture" })!;
    const fakeBrokerCall = vi.fn(async (actor: string, tool: string, approved: boolean) => {
      expect(actor).toBe(ownerId);
      expect(tool).toBe("search");
      expect(approved).toBe(false);
      return { result: "Synthetic public documentation result" };
    });
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpCapability: registry.resolve }));
    app.get("/api/mcp-servers", (c) => c.json([{
      id: serverId, name: "Public docs fixture", status: "ready", enabled: true, revision: 10,
    }]));
    app.get(`/api/mcp-servers/${serverId}`, (c) => c.json({
      id: serverId, name: "Public docs fixture", status: "ready", enabled: true, revision: 10,
      tools: [{ name: "search", description: "Search public documentation", enabled: true,
        approval: "allow", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
    }));
    app.post(`/api/mcp-servers/${serverId}/call`, async (c) => {
      const body = await c.req.json() as { tool: string; approvalGranted: boolean };
      return c.json(await fakeBrokerCall(requireRequestPrincipal(c).userId, body.tool, body.approvalGranted));
    });
    const httpServer = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const address = httpServer.address() as AddressInfo;
        const result = await app.fetch(new Request(`http://127.0.0.1:${address.port}${request.url}`, {
          method: request.method,
          headers: request.headers as HeadersInit,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(500);
        response.end();
      }
    });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const port = (httpServer.address() as AddressInfo).port;
    const client = new Client({ name: "canonical-claude-scoped-fixture", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["packages/integrations-mcp/dist/cli.js"],
      env: {
        PATH: process.env.PATH ?? "",
        GATEWAY_URL: `http://127.0.0.1:${port}`,
        MATRIX_AGENT_INTEGRATIONS_TOKEN: capability.token,
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "list_custom_mcp_servers", "describe_custom_mcp_server", "call_custom_mcp_tool",
      ]));
      const inventory = await client.callTool({ name: "list_custom_mcp_servers" });
      expect(JSON.stringify(inventory.content)).toContain("Public docs fixture");
      const description = await client.callTool({
        name: "describe_custom_mcp_server", arguments: { server_id: serverId },
      });
      expect(JSON.stringify(description.content)).toContain("search [approval: allow]");
      const result = await client.callTool({
        name: "call_custom_mcp_tool", arguments: { server_id: serverId, tool: "search", arguments: { query: "public docs" } },
      });
      expect(JSON.stringify(result.content)).toContain("Synthetic public documentation result");
      expect(fakeBrokerCall).toHaveBeenCalledOnce();

      capability.revoke();
      const denied = await client.callTool({ name: "list_custom_mcp_servers" });
      expect(JSON.stringify(denied.content)).toContain("currently unavailable");
      expect(fakeBrokerCall).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      registry.close();
    }
  });
});
