import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi, afterEach } from "vitest";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";
afterEach(() => vi.unstubAllEnvs());
async function connect(fetcher: GatewayFetcher) { const server = createIntegrationsMcpServer({ fetcher, toolSurface: "custom-mcp-discovery-drive" }); const client = new Client({ name: "drive-fixture", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]); return { client, close: async () => { await client.close(); await server.close(); } }; }
it("advertises read-only company tools alongside the exact existing discovery surface", async () => { const f = await connect(vi.fn()); try {
    expect((await f.client.listTools()).tools.map(tool => tool.name)).toEqual(["search_company_drive", "read_company_drive_file", "list_custom_mcp_servers", "describe_custom_mcp_server"]);
}
finally {
    await f.close();
} });
it("uses the selected reference index and scoped local gateway bearer", async () => { vi.stubEnv("MATRIX_AUTH_TOKEN", "synthetic-scoped"); const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({ organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001", files: [] })); const f = await connect(fetcher); try {
    const result = await f.client.callTool({ name: "search_company_drive", arguments: { referenceIndex: 0, query: "plan" } });
    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/chat-drive-context/search", expect.objectContaining({ method: "POST", redirect: "error", signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: "Bearer synthetic-scoped" }) }));
}
finally {
    await f.close();
} });
it("rejects a forged owner or run and never exposes a source error", async () => { const fetcher = vi.fn<GatewayFetcher>(async () => new Response("/private/server", { status: 500 })); const f = await connect(fetcher); try {
    expect((await f.client.callTool({ name: "search_company_drive", arguments: { referenceIndex: 0, runId: "run_forged" } })).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    const failed = await f.client.callTool({ name: "read_company_drive_file", arguments: { referenceIndex: 0 } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("/private/server");
}
finally {
    await f.close();
} });
