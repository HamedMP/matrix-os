import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";

const owner = { type: "personal", ownerId: "user_owner" };

describe("personal integration and company Drive merge boundaries", () => {
  it.each(["chat_call", "chat_discovery"] as const)("keeps company reads alongside %s authorization", async scope => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const capability = registry.issue({ owner, runId: "run_selected", scope, driveContext: true })!;
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/tmp/project", runtimeHome: "/tmp/home",
      matrixCustomMcp: true, matrixDriveContext: true, matrixCustomMcpScope: scope,
      claudePermissionMode: "default", sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/tmp/project"] } });
    const mcp = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!);
    const surface = mcp.mcpServers["matrix-integrations"].args[1].split("=")[1];
    const server = createIntegrationsMcpServer({ toolSurface: surface, fetcher: vi.fn() });
    const client = new Client({ name: "merged-drive-fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      expect(tools).toEqual(expect.arrayContaining(["search_company_drive", "read_company_drive_file",
        "list_integration_inventory", "describe_service", "list_custom_mcp_servers"]));
      expect(tools.includes("call_service")).toBe(scope === "chat_call");
      expect(tools.includes("call_custom_mcp_tool")).toBe(scope === "chat_call");
      expect(registry.resolveRunContext(capability.token, "POST", "/api/chat-drive-context/search"))
        .toMatchObject({ actorId: owner.ownerId, runId: "run_selected", driveContext: true });
      const context = registry.resolveRunContext(capability.token, "POST", "/api/integrations/call");
      if (scope === "chat_call") {
        expect(context?.consumeIntegrationRequest?.("POST", "/api/integrations/call", {
          service: "google_drive", action: "list_files", account: "work", params: { maxResults: 3 },
        })).toBe(false);
      } else expect(context).toBeNull();
      expect(registry.resolve(capability.token, "POST", "/api/files")).toBeNull();
      capability.revoke();
      expect(registry.resolve(capability.token, "POST", "/api/chat-drive-context/read")).toBeNull();
    } finally {
      registry.close();
      await client.close();
      await server.close();
    }
  });

  it("never widens an approved shared Preview Google Drive lease into company Drive context", () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    try {
      expect(registry.authorizePreviewDriveRun({ actorId: owner.ownerId, chatId: "chat_selected",
        runId: "run_selected", runGrant: "a".repeat(64) })).toBe(true);
      expect(registry.issue({ owner, runId: "run_selected", scope: "chat_call", driveContext: true })).toBeNull();
      const capability = registry.issue({ owner, runId: "run_selected", scope: "chat_call" })!;
      expect(capability.surface).toBe("preview_drive_call");
      expect(registry.resolve(capability.token, "POST", "/api/chat-drive-context/search")).toBeNull();
      expect(registry.resolve(capability.token, "POST", "/api/chat-drive-context/read")).toBeNull();
    } finally { registry.close(); }
  });
});
