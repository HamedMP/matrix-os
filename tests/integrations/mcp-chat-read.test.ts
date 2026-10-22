import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import { getService } from "../../packages/gateway/src/integrations/registry.js";
import { isScopedReadCatalogRequest, projectIntegrationCatalog } from "../../packages/gateway/src/integrations/catalog-projection.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

afterEach(() => vi.unstubAllEnvs());

async function fixture(surface: "custom-mcp-call-integrations" | "custom-mcp-discovery-integrations" | "custom-mcp-call-integrations-drive" = "custom-mcp-call-integrations") {
  const ownerId = "owner_mcp_read";
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: ownerId });
  const grant = registry.issue({ owner: { type: "personal", ownerId }, runId: "run_read", scope: surface.includes("discovery") ? "discovery" : "call", integrationRead: true, ...(surface.endsWith("-drive") ? { driveContext: true } : {}) })!;
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", grant.token);
  vi.stubEnv("MATRIX_AUTH_TOKEN", "must-never-cross-boundary");
  const accounts = [{ id: "account_work", service: "google_drive", account_label: "Work", status: "active", pipedream_account_id: "pd_work" }, { id: "account_personal", service: "google_drive", account_label: "Personal", status: "active", pipedream_account_id: "pd_personal" }];
  const db = { listConnectedServices: vi.fn(async (actor: string) => { expect(actor).toBe(ownerId); return accounts; }), getUserById: vi.fn(async (actor: string) => { expect(actor).toBe(ownerId); return { pipedream_external_id: "external_owner" }; }), touchServiceUsage: vi.fn(async () => {}) };
  const proxyGet = vi.fn(async () => ({ files: [{ id: "file_notes", name: "Notes" }] }));
  const proxyPost = vi.fn();
  const gateway = new Hono();
  gateway.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
  gateway.get("/api/integrations", c => c.json(accounts));
  gateway.get("/api/integrations/agent-catalog", async c => c.json(await projectIntegrationCatalog({ services: [getService("google_drive")!], uid: requireRequestPrincipal(c).userId, capabilityIdentityFailed: false, authoritative: true, readOnly: isScopedReadCatalogRequest(c), logoUrl: () => "" })));
  gateway.route("/api/integrations", createIntegrationReadCallRoutes({ db: db as never, pipedream: { proxyGet, proxyPost } as never, resolveUserId: async c => requireRequestPrincipal(c).userId }));
  const fetcher = vi.fn<GatewayFetcher>(async (url, init) => gateway.request(new URL(url).pathname, init));
  const server = createIntegrationsMcpServer({ fetcher, toolSurface: surface as never });
  const client = new Client({ name: "chat-read-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, fetcher, proxyGet, proxyPost, grant, registry, close: async () => { await client.close(); await server.close(); registry.close(); } };
}

describe("Chat connected integration read MCP wiring", () => {
  it.each(["custom-mcp-call-integrations", "custom-mcp-discovery-integrations", "custom-mcp-call-integrations-drive"] as const)("advertises only reads alongside the selected custom/company surface: %s", async surface => {
    const f = await fixture(surface);
    try {
      const tools = (await f.client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["list_integration_inventory", "describe_service", "call_service", "list_custom_mcp_servers", "describe_custom_mcp_server"]));
      expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(["connect_service", "sync_services", "disconnect_service"]));
      expect(tools.some(tool => tool.name === "call_custom_mcp_tool")).toBe(!surface.includes("discovery"));
      expect(tools.some(tool => tool.name === "read_company_drive_file")).toBe(surface.endsWith("-drive"));
      const readCall = tools.find(tool => tool.name === "call_service")!;
      expect(readCall.annotations?.readOnlyHint).toBe(true);
      expect(readCall.inputSchema.required).toContain("label");
      expect(f.client.getInstructions()).toContain("exact account label");
    } finally { await f.close(); }
  });

  it("roundtrips inventory, read catalog and an exact owner Drive account through the real broker", async () => {
    const f = await fixture();
    try {
      const inventory = await f.client.callTool({ name: "list_integration_inventory" });
      expect(JSON.stringify(inventory)).toContain("Work");
      expect(JSON.stringify(inventory)).toContain("Personal");
      expect(JSON.stringify(inventory)).not.toContain("pd_work");
      const description = await f.client.callTool({ name: "describe_service", arguments: { service: "google_drive" } });
      expect(JSON.stringify(description)).toContain("list_files [read]");
      expect(JSON.stringify(description)).not.toContain("upload_file");
      const result = await f.client.callTool({ name: "call_service", arguments: { service: "google_drive", action: "list_files", label: "Personal", params: {} } });
      expect(JSON.stringify(result)).toContain("Notes");
      expect(f.proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "pd_personal", externalUserId: "external_owner" }));
      expect(f.fetcher.mock.calls.at(-1)![0]).toMatch(/\/api\/integrations\/read-call$/);
      expect(f.fetcher.mock.calls.at(-1)![1].headers).toMatchObject({ Authorization: `Bearer ${f.grant.token}` });
      expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain("must-never-cross-boundary");
      expect(f.proxyPost).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("denies missing/foreign account labels, writes and unknown management tools", async () => {
    const f = await fixture();
    try {
      const missing = await f.client.callTool({ name: "call_service", arguments: { service: "google_drive", action: "list_files" } });
      expect(missing.isError).toBe(true);
      const foreign = await f.client.callTool({ name: "call_service", arguments: { service: "google_drive", action: "list_files", label: "Foreign" } });
      expect(foreign.isError).toBe(true);
      const write = await f.client.callTool({ name: "call_service", arguments: { service: "google_drive", action: "upload_file", label: "Work", params: {} } });
      expect(write.isError).toBe(true);
      const manage = await f.client.callTool({ name: "connect_service", arguments: { service: "google_drive" } });
      expect(manage.isError).toBe(true);
      expect(f.proxyGet).not.toHaveBeenCalled();
      expect(f.proxyPost).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("denies revoked authority before reads and never exposes the broker error body", async () => {
    const f = await fixture();
    try {
      f.grant.revoke();
      const result = await f.client.callTool({ name: "call_service", arguments: { service: "google_drive", action: "list_files", label: "Work" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Integration read is unavailable");
      expect(JSON.stringify(result)).not.toContain("Unauthorized");
      expect(f.proxyGet).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
