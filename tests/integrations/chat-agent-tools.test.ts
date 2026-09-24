import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHmac } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import { saved } from "../desktop/chat-agents-fixture";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

afterEach(() => vi.unstubAllEnvs());
async function connect(fetcher: GatewayFetcher) {
  const server = createIntegrationsMcpServer({ fetcher });
  const client = new Client({ name: "agent-authoring-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const draft = { clientRequestId: "req_agent_authoring", name: "Meeting helper", description: "Prepare meetings",
  instructions: "Summarize decisions.", selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" } };

it("discovers available model and skill metadata without exposing saved instructions", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.instances[0]!.models.push({ ...catalog.instances[0]!.models[0]!, id: "unavailable_model", availability: "unavailable" });
  const fetcher = vi.fn<GatewayFetcher>(async (url) => Response.json(url.endsWith("/api/chat-providers") ? catalog
    : url.endsWith("/recipe-catalog") ? { enabled: true, skills: [], services: [] }
    : { enabled: true, agents: [{ ...saved, instructions: "Private instructions are not discovery metadata" }] }));
  const { client, close } = await connect(fetcher);
  try {
    const result = await client.callTool({ name: "list_chat_agent_options", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("codex_fixture");
    expect(JSON.stringify(result)).not.toContain("unavailable_model");
    expect(JSON.stringify(result)).not.toContain("Private instructions");
  } finally { await close(); }
});

it("creates through the owner-authenticated canonical route and retains its retry key", async () => {
  vi.stubEnv("MATRIX_AUTH_TOKEN", "test-only-token");
  vi.stubEnv("MATRIX_CLERK_USER_ID", "owner_fixture");
  const fetcher = vi.fn<GatewayFetcher>(async () => new Response(JSON.stringify({ ...saved, selection: draft.selection }), { status: 201 }));
  const { client, close } = await connect(fetcher);
  try {
    const result = await client.callTool({ name: "create_chat_agent", arguments: draft });
    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/chat-agents", expect.objectContaining({
      method: "POST", signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Authorization: "Bearer test-only-token", "x-platform-user-id": "owner_fixture",
        "x-platform-verified": createHmac("sha256", "test-only-token").update("owner_fixture").digest("hex") }),
    }));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual(draft);
    expect(JSON.stringify(result)).toContain(saved.id);
    expect(JSON.stringify(result)).not.toContain("test-only-token");
  } finally { await close(); }
});
it("rejects forged owners before contacting the gateway", async () => {
  const fetcher = vi.fn<GatewayFetcher>();
  const { client, close } = await connect(fetcher);
  try {
    const result = await client.callTool({ name: "create_chat_agent", arguments: { ...draft, ownerId: "someone_else" } });
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await close(); }
});
it("reports a failed save without exposing gateway errors or claiming success", async () => {
  const fetcher = vi.fn<GatewayFetcher>(async () => new Response("secret database path", { status: 503 }));
  const { client, close } = await connect(fetcher);
  try {
    const result = await client.callTool({ name: "create_chat_agent", arguments: draft });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret database path");
  } finally { await close(); }
});
