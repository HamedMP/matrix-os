import { describe, expect, it, vi } from "vitest";
import {
  RemoteMcpClient,
  type RemoteMcpRequest,
  type RemoteMcpRequester,
} from "../../packages/gateway/src/integrations/custom-mcp/client.js";

function requester(responses: Array<{ body?: unknown; headers?: Record<string, string>; status?: number }>): RemoteMcpRequester {
  return vi.fn(async (_request: RemoteMcpRequest) => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected MCP request");
    return {
      status: response.status ?? 200,
      headers: response.headers ?? {},
      body: response.body,
    };
  });
}

describe("remote Streamable HTTP MCP client", () => {
  it("initializes, pins a session, and discovers bounded disabled tools", async () => {
    const request = requester([
      {
        headers: { "mcp-session-id": "session-1" },
        body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } },
      },
      { body: undefined },
      {
        body: {
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [{ name: "search", description: "Search safely", inputSchema: { type: "object", properties: {} } }],
          },
        },
      },
    ]);
    const client = new RemoteMcpClient({ requester: request });
    const tools = await client.discover({
      serverId: "server-1",
      url: "https://mcp.acme.tools/mcp",
      authorization: "Bearer hidden",
    });

    expect(tools).toEqual([{
      name: "search",
      description: "Search safely",
      inputSchema: { type: "object", properties: {} },
      approval: "always_ask",
      enabled: false,
    }]);
    expect(request).toHaveBeenNthCalledWith(3, expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer hidden",
        "mcp-session-id": "session-1",
      }),
      timeoutMs: 10_000,
    }));
  });

  it("refuses schemas over 32 KB and catalogs over 100 tools", async () => {
    const hugeSchema = { description: "x".repeat(33 * 1024) };
    const request = requester([
      { body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } } },
      { body: undefined },
      { body: { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "huge", inputSchema: hugeSchema }] } } },
    ]);
    await expect(new RemoteMcpClient({ requester: request }).discover({
      serverId: "server-1",
      url: "https://mcp.acme.tools/mcp",
    })).rejects.toThrow(/schema limit/i);

    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: { type: "object" },
    }));
    const manyRequest = requester([
      { body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } } },
      { body: undefined },
      { body: { jsonrpc: "2.0", id: 2, result: { tools: tooMany } } },
    ]);
    await expect(new RemoteMcpClient({ requester: manyRequest }).discover({
      serverId: "server-1",
      url: "https://mcp.acme.tools/mcp",
    })).rejects.toThrow(/tool limit/i);
  });

  it("uses the 30-second timeout for tool calls", async () => {
    const request = requester([
      { body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } } },
      { body: undefined },
      { body: { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } } },
    ]);
    const client = new RemoteMcpClient({ requester: request });
    await client.callTool({
      serverId: "server-1",
      url: "https://mcp.acme.tools/mcp",
      toolName: "search",
      arguments: { q: "matrix" },
    });
    expect(request).toHaveBeenNthCalledWith(3, expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("reuses bounded sessions and drains them on shutdown", async () => {
    const request = requester([
      { headers: { "mcp-session-id": "session-1" }, body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } } },
      { body: undefined },
      { body: { jsonrpc: "2.0", id: 2, result: { tools: [] } } },
      { body: { jsonrpc: "2.0", id: 3, result: { tools: [] } } },
      { body: undefined },
    ]);
    const client = new RemoteMcpClient({ requester: request });
    const connection = { serverId: "server-1", url: "https://mcp.acme.tools/mcp" };
    await client.discover(connection);
    await client.discover(connection);
    await client.shutdown();
    expect(request).toHaveBeenCalledTimes(5);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({ "mcp-session-id": "session-1" }),
    }));
  });

  it("coalesces concurrent initialization and drains the shared session once", async () => {
    let releaseInitialize!: () => void;
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const request = vi.fn(async (input: RemoteMcpRequest) => {
      const body = input.body as { method?: string; id?: number } | undefined;
      if (body?.method === "initialize") {
        await initializeGate;
        return {
          status: 200,
          headers: { "mcp-session-id": "shared-session" },
          body: {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18" },
          },
        };
      }
      if (body?.method === "tools/list") {
        return {
          status: 200,
          headers: {},
          body: { jsonrpc: "2.0", id: body.id, result: { tools: [] } },
        };
      }
      return { status: 200, headers: {}, body: undefined };
    });
    const client = new RemoteMcpClient({ requester: request });
    const connection = { serverId: "server-1", url: "https://mcp.acme.tools/mcp" };

    const first = client.discover(connection);
    const second = client.discover(connection);
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([input]) =>
        (input.body as { method?: string } | undefined)?.method === "initialize"))
        .toHaveLength(1);
    });
    releaseInitialize();
    await Promise.all([first, second]);
    await client.shutdown();

    expect(request.mock.calls.filter(([input]) =>
      (input.body as { method?: string } | undefined)?.method === "initialize"))
      .toHaveLength(1);
    expect(request.mock.calls.filter(([input]) => input.method === "DELETE"))
      .toHaveLength(1);
  });

  it("does not initialize a new session after shutdown starts during eviction", async () => {
    let now = 0;
    let releaseEviction!: () => void;
    const evictionGate = new Promise<void>((resolve) => {
      releaseEviction = resolve;
    });
    let initializeCount = 0;
    const request = vi.fn(async (input: RemoteMcpRequest) => {
      const body = input.body as { method?: string; id?: number } | undefined;
      if (input.method === "DELETE") {
        await evictionGate;
        return { status: 204, headers: {}, body: undefined };
      }
      if (body?.method === "initialize") {
        initializeCount += 1;
        return {
          status: 200,
          headers: { "mcp-session-id": `session-${initializeCount}` },
          body: {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18" },
          },
        };
      }
      if (body?.method === "tools/list") {
        return {
          status: 200,
          headers: {},
          body: { jsonrpc: "2.0", id: body.id, result: { tools: [] } },
        };
      }
      return { status: 200, headers: {}, body: undefined };
    });
    const client = new RemoteMcpClient({ requester: request, sessionTtlMs: 1, now: () => now });
    const connection = { serverId: "server-1", url: "https://mcp.acme.tools/mcp" };

    await client.discover(connection);
    now = 2;
    const lateDiscovery = client.discover(connection);
    await vi.waitFor(() => expect(request.mock.calls.some(([input]) => input.method === "DELETE")).toBe(true));
    await client.shutdown();
    releaseEviction();

    await expect(lateDiscovery).rejects.toThrow(/shutting down/i);
    expect(initializeCount).toBe(1);
  });
});
