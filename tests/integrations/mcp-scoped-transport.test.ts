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
import { authorizeChatIntegrationRequest } from "../../packages/gateway/src/integrations/chat-action-guard.js";

const serverId = "123e4567-e89b-42d3-a456-426614174000";

describe("scoped Claude-to-Matrix MCP transport", () => {
  it.each([
    { surface: "custom-mcp-call", scope: "call" as const },
    { surface: "chat-call", scope: "chat_call" as const },
    { surface: "full", scope: "call" as const },
    { surface: "full", scope: "discovery" as const },
  ])("keeps $surface presentation within the $scope grant and denies reuse after revoke", async ({ surface, scope }) => {
    const ownerId = "owner_claude";
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: ownerId });
    const capability = registry.issue({ owner: { type: "personal", ownerId }, runId: "run_fixture", scope })!;
    const fakeBrokerCall = vi.fn(async (actor: string, tool: string, approved: boolean) => {
      expect(actor).toBe(ownerId);
      expect(tool).toBe("search");
      expect(approved).toBe(false);
      return { result: "Synthetic public documentation result" };
    });
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    const forbiddenInventory = vi.fn(() => [{ service: "google_drive", account_label: "work", account_email: null, status: "active" }]);
    app.get("/api/integrations", c => c.json(forbiddenInventory()));
    app.get("/api/integrations/agent-catalog", c => c.json([{ id: "google_drive", name: "Google Drive",
      actions: { list_files: { description: "List bounded file metadata", risk: "read", params: { max_results: { type: "number" } } } } }]));
    const providerRead = vi.fn(async (_input: unknown) => ({ files: [{ id: "fixture-public", name: "Synthetic document" }] }));
    app.post("/api/integrations/call", async c => {
      const denied = await authorizeChatIntegrationRequest(c);
      if (denied) return denied;
      return c.json(await providerRead(await c.req.json()));
    });
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
      args: ["packages/integrations-mcp/dist/cli.js", `--tool-surface=${surface}`],
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
      const canCall = scope === "call" || scope === "chat_call";
      if (canCall) expect(JSON.stringify(result.content)).toContain("Synthetic public documentation result");
      else expect(JSON.stringify(result.content)).toContain("tool call was rejected");
      expect(fakeBrokerCall).toHaveBeenCalledTimes(canCall ? 1 : 0);
      if (surface === "chat-call") {
        const inventory = await client.callTool({ name: "list_integration_inventory" });
        expect(JSON.stringify(inventory.content)).toContain("google_drive (work) [active]");
        const schema = await client.callTool({ name: "describe_service", arguments: { service: "google_drive" } });
        expect(JSON.stringify(schema.content)).toContain("list_files");
        const action = { service: "google_drive", action: "list_files", label: "work", params: { max_results: 3 } };
        const denied = await client.callTool({ name: "call_service", arguments: action });
        expect(JSON.stringify(denied.content)).toContain("approval required");
        expect(providerRead).not.toHaveBeenCalled();
        const grant = capability.grantIntegrationTool!("mcp__matrix-integrations__call_service", action)!;
        const approved = { ...action, matrix_approval_receipt: grant.receipt };
        const read = await client.callTool({ name: "call_service", arguments: approved });
        expect(JSON.stringify(read.content)).toContain("Synthetic document");
        const replay = await client.callTool({ name: "call_service", arguments: approved });
        expect(JSON.stringify(replay.content)).toContain("approval required");
        expect(providerRead).toHaveBeenCalledOnce();
        expect(providerRead).toHaveBeenCalledWith(action);
      }
      if (surface === "full") {
        const deniedInventory = await client.callTool({ name: "list_integration_inventory" });
        expect(JSON.stringify(deniedInventory.content)).toContain("unavailable");
        expect(forbiddenInventory).not.toHaveBeenCalled();
      }

      capability.revoke();
      const denied = await client.callTool({ name: "list_custom_mcp_servers" });
      expect(JSON.stringify(denied.content)).toContain("currently unavailable");
      expect(fakeBrokerCall).toHaveBeenCalledTimes(canCall ? 1 : 0);
    } finally {
      await client.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      registry.close();
    }
  });
});
