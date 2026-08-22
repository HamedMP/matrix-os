import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/dist/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

async function connect(fetcher: GatewayFetcher) {
  const server = createIntegrationsMcpServer({ fetcher });
  const client = new Client({ name: "matrix-integrations-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Matrix integrations MCP server", () => {
  it("advertises the stable integration tool contract to every MCP client", async () => {
    const fetcher = vi.fn<GatewayFetcher>();
    const { client, server } = await connect(fetcher);

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "list_integration_inventory",
      "list_connected_services",
      "describe_service",
      "connect_service",
      "sync_services",
      "call_service",
      "disconnect_service",
    ]);
    expect(listed.tools[0]?.description).toContain("new conversation");

    await client.close();
    await server.close();
  });

  it("returns safe Gmail connection context without returning mailbox data", async () => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response(200, [
      {
        id: "connection-secret-id",
        service: "gmail",
        account_label: "Work",
        account_email: "user@example.com",
        status: "active",
        pipedream_account_id: "provider-secret-id",
      },
    ]));
    const { client, server } = await connect(fetcher);

    const result = await client.callTool({ name: "list_integration_inventory", arguments: {} });
    const text = (result.content[0] as { type: "text"; text: string }).text;

    expect(text).toContain("Gmail (Work, user@example.com) [active]");
    expect(text).not.toContain("connection-secret-id");
    expect(text).not.toContain("provider-secret-id");

    await client.close();
    await server.close();
  });

  it("proxies approved service calls through the local gateway", async () => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response(200, { messages: [{ id: "m1" }] }));
    const { client, server } = await connect(fetcher);

    const result = await client.callTool({
      name: "call_service",
      arguments: { service: "gmail", action: "list_messages", params: { maxResults: 5 } },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/integrations/call",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          service: "gmail",
          action: "list_messages",
          params: { maxResults: 5 },
        }),
      }),
    );
    expect((result.content[0] as { type: "text"; text: string }).text).toContain('"m1"');

    await client.close();
    await server.close();
  });

  it("disconnects only by an explicit Matrix connection id", async () => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response(200, { ok: true }));
    const { client, server } = await connect(fetcher);

    const result = await client.callTool({
      name: "disconnect_service",
      arguments: { connection_id: "11111111-1111-4111-8111-111111111111" },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/integrations/11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("Disconnected");

    await client.close();
    await server.close();
  });
});
