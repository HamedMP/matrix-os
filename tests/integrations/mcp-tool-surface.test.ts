import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const customDiscovery = ["list_custom_mcp_servers", "describe_custom_mcp_server"];
const fullBaseline = [
  "list_integration_inventory", "list_connected_services", "describe_service",
  "connect_service", "sync_services", "call_service", "disconnect_service",
  ...customDiscovery, "call_custom_mcp_tool", "jev_evaluate",
  "list_chat_agent_options", "create_chat_agent",
];

async function withClient(surface: string | undefined, inspect: (client: Client) => Promise<void>) {
  const client = new Client({ name: "scoped-claude-advertisement-fixture", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["packages/integrations-mcp/dist/cli.js", ...(surface ? [`--tool-surface=${surface}`] : [])],
    env: { PATH: process.env.PATH ?? "", GATEWAY_URL: "http://127.0.0.1:4000" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    await inspect(client);
  } finally {
    await client.close();
  }
}

describe("Matrix MCP advertises only the selected runnable surface", () => {
  it("custom call clients discover the broker path without unavailable integration recommendations", async () => {
    await withClient("custom-mcp-call", async client => {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
        ...customDiscovery, "call_custom_mcp_tool",
      ]);
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("list_custom_mcp_servers");
      expect(instructions).toContain("describe_custom_mcp_server");
      expect(instructions).toContain("call_custom_mcp_tool");
      expect(instructions).not.toMatch(/list_integration_inventory|describe_service|call_service/);
    });
  });

  it("discovery clients cannot discover or invoke broker calls", async () => {
    await withClient("custom-mcp-discovery", async client => {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(customDiscovery);
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("list_custom_mcp_servers");
      expect(instructions).toContain("describe_custom_mcp_server");
      expect(instructions).not.toMatch(/list_integration_inventory|call_custom_mcp_tool/);
      const result = await client.callTool({ name: "call_custom_mcp_tool", arguments: {
        server_id: "123e4567-e89b-42d3-a456-426614174000", tool: "search",
      } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not found");
    });
  });

  it.each([undefined, "full"])("preserves the existing full integration surface for %s", async surface => {
    await withClient(surface, async client => {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(fullBaseline);
      expect(client.getInstructions()).toContain("list_integration_inventory");
    });
  });

  it("rejects an unknown surface instead of advertising full tools", async () => {
    await expect(withClient("unrecognized", async () => {})).rejects.toThrow();
  });
});
