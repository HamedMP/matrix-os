import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

afterEach(() => vi.unstubAllEnvs());
async function connect(fetcher: GatewayFetcher) {
  const server = createIntegrationsMcpServer({ fetcher, toolSurface: "jev-inbox-preview" });
  const client = new Client({ name: "recipe-fixture", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
it("advertises only the receipt-bound Inbox broker", async () => {
  const { client, close } = await connect(vi.fn<GatewayFetcher>());
  try { expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["jev_inbox_preview"]); }
  finally { await close(); }
});
it.each([
  { operation: "discover", ownerId: "forged" },
  { operation: "discover", verified: true },
  { operation: "select", receipt: "a".repeat(64) },
  { operation: "evaluate", receipt: "a".repeat(64), state: "forged content" },
  { operation: "write", threadId: "abc" },
])("denies untrusted authority/input %j before contacting Gateway", async (input) => {
  const fetcher = vi.fn<GatewayFetcher>();
  const { client, close } = await connect(fetcher);
  try {
    expect((await client.callTool({ name: "jev_inbox_preview", arguments: input })).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await close(); }
});
it("uses the fixed local route with scoped authentication and preserves a receipt", async () => {
  vi.stubEnv("MATRIX_AUTH_TOKEN", "synthetic-scoped-token");
  const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({ kind: "discovery", receipt: "a".repeat(64), threads: [], readonly: true }));
  const { client, close } = await connect(fetcher);
  try {
    const result = await client.callTool({ name: "jev_inbox_preview", arguments: { operation: "discover" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("a".repeat(64));
    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/jev/inbox/preview", expect.objectContaining({
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Authorization: "Bearer synthetic-scoped-token" }),
      body: JSON.stringify({ operation: "discover" }),
    }));
  } finally { await close(); }
});
it("accepts the shared maximum-length thread identifier without extending authority", async () => {
  const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({ kind: "review", verified: false, readonly: true }));
  const { client, close } = await connect(fetcher);
  try {
    expect((await client.callTool({ name: "jev_inbox_preview", arguments: {
      operation: "select", receipt: "a".repeat(64), threadId: "t".repeat(160),
    } })).isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { await close(); }
});
it.each([503, 200])("withholds raw errors and oversized broker responses (status %i)", async (status) => {
  const fetcher = vi.fn<GatewayFetcher>(async () => new Response("private-payload".repeat(10_000), { status }));
  const { client, close } = await connect(fetcher);
  try {
    const result = await client.callTool({ name: "jev_inbox_preview", arguments: { operation: "discover" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-payload");
  } finally { await close(); }
});
