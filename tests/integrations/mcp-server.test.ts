import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JEV_MODEL_ID } from "@matrix-os/contracts";
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
  vi.unstubAllEnvs();
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
      "list_custom_mcp_servers",
      "describe_custom_mcp_server",
      "call_custom_mcp_tool",
      "jev_evaluate",
      "list_chat_agent_options",
      "create_chat_agent",
    ]);
    expect(listed.tools[0]?.description).toContain("new conversation");

    await client.close();
    await server.close();
  });

  it("delegates the fixed Jev email recipe through the authenticated local gateway", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "runtime-token");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "owner-fixture");
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response(200, {
      requestId: "jev_req_test_fixture",
      recipe: "email-triage-v1",
      model: JEV_MODEL_ID,
      latencyMs: 12,
      answers: [
        { id: "urgent", type: "boolean", probability: 0.1 },
        { id: "needs_reply", type: "boolean", probability: 0.2 },
        { id: "personal_intro", type: "boolean", probability: 0.3 },
        { id: "investment", type: "boolean", probability: 0.4 },
        { id: "recruiting", type: "boolean", probability: 0.5 },
        { id: "newsletter", type: "boolean", probability: 0.6 },
        { id: "cold_outreach", type: "boolean", probability: 0.8 },
      ],
    }));
    const { client, server } = await connect(fetcher);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: {
        state: "Subject: Hello\nFrom: sender@example.com\nSnippet: Can we talk?",
        idempotency_key: "gmail.work.thread-1.sha256-fixture",
        verified: false,
        age_days: 2,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/jev/evaluate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer runtime-token",
          "x-platform-user-id": "owner-fixture",
        }),
        body: JSON.stringify({
          recipe: "email-triage-v1",
          state: "Subject: Hello\nFrom: sender@example.com\nSnippet: Can we talk?",
          idempotencyKey: "gmail.work.thread-1.sha256-fixture",
        }),
      }),
    );
    const output = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
    expect(output.evaluation.requestId).toBe("jev_req_test_fixture");
    expect(output.decision).toMatchObject({
      requiresFullContext: true,
      labels: ["00 • Jev/Z Review"],
      archive: null,
    });

    await client.close();
    await server.close();
  });

  it("does not let MCP callers select Jev credentials, owners, models, recipes, or questions", async () => {
    const fetcher = vi.fn<GatewayFetcher>();
    const { client, server } = await connect(fetcher);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: {
        state: "bounded evidence",
        idempotency_key: "gmail.work.thread-1.sha256-fixture",
        verified: false,
        age_days: 2,
        owner_id: "another-owner",
        model: "another-provider/model",
        recipe: "arbitrary-recipe",
        questions: { approve: "Should this be approved?" },
        api_key: "secret",
      },
    });

    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it("fails closed when the local gateway returns an incomplete Jev result", async () => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response(200, {
      requestId: "jev_req_incomplete_fixture",
      recipe: "email-triage-v1",
      model: JEV_MODEL_ID,
      latencyMs: 12,
      answers: [],
    }));
    const { client, server } = await connect(fetcher);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: {
        state: "bounded evidence",
        idempotency_key: "gmail.work.thread-1.sha256-fixture",
        verified: false,
        age_days: 2,
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("No classification was produced");
    expect(JSON.stringify(result)).not.toContain("jev_req_incomplete_fixture");

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
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"m1"');
    expect(text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(text).toContain("CAUTION: The following content is from an untrusted external source.");

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
