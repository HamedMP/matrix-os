/**
 * Layer-3 integration checkpoint (spec 2691): search_tools -> call_tool from
 * the real stdio MCP binary, through the scoped gateway auth and the Core
 * routes, into the real broker and two fake upstream MCP servers, writes
 * exactly one content-free usage row per call to Postgres.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { CoreToolService } from "../../packages/gateway/src/integrations/custom-mcp/core-tools.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import { bootstrapMcpUsageDatabase, createMcpUsageRepository, type McpUsageDatabase } from "../../packages/platform/src/mcp-usage/database.js";
import { createMcpUsageWriter } from "../../packages/platform/src/mcp-usage/writer.js";
import { createCoreFixture, type CoreFixture, type FakeUpstream } from "./core-mcp-fixture.js";

describe("Matrix Core MCP usage checkpoint", () => {
  let fixture: CoreFixture;
  let usageDb: Kysely<McpUsageDatabase>;
  let linear: FakeUpstream;
  let docs: FakeUpstream;

  beforeEach(async () => {
    linear = { host: "mcp.linear.test", calls: [], tools: [
      { name: "list_issues", description: "List Linear issues." },
      { name: "create_issue", description: "Create a Linear issue." },
    ] };
    docs = { host: "docs.example.test", calls: [], tools: [{ name: "search_docs", description: "Search documentation about issues." }] };
    fixture = await createCoreFixture([linear, docs]);
    usageDb = new Kysely<McpUsageDatabase>({ dialect: fixture.pglite.dialect });
    await bootstrapMcpUsageDatabase(usageDb);
    await fixture.connect("Linear", linear.host, { list_issues: "allow", create_issue: "always_ask" });
    await fixture.connect("Docs", docs.host, { search_docs: "allow" });
  });
  afterEach(async () => { await fixture.close(); });

  it("writes exactly one content-free row per call across two upstreams and none for discovery", async () => {
    const writer = createMcpUsageWriter({ insert: rows => createMcpUsageRepository(usageDb).insertEvents(rows) });
    const core = new CoreToolService({ broker: fixture.broker, approvals: fixture.db, usage: writer });
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: fixture.actorId });
    const capability = registry.issue({ owner: { type: "personal", ownerId: fixture.actorId }, runId: "run_checkpoint", scope: "call" })!;
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    app.route("/api/mcp-servers", createCustomMcpRoutes({ broker: fixture.broker, core, allowToolCalls: true,
      resolveUserId: async () => fixture.userId, resolveActorId: () => fixture.actorId }));
    const httpServer = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await app.fetch(new Request(`http://127.0.0.1${request.url}`, {
          method: request.method, headers: request.headers as HeadersInit, body: chunks.length ? Buffer.concat(chunks) : undefined,
        }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error: unknown) {
        console.error("checkpoint server failed", error);
        response.writeHead(500);
        response.end();
      }
    });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const client = new Client({ name: "core-mcp-checkpoint", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["packages/integrations-mcp/dist/cli.js", "--tool-surface=custom-mcp-call"],
      env: { PATH: process.env.PATH ?? "", GATEWAY_URL: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
        MATRIX_AGENT_INTEGRATIONS_TOKEN: capability.token, MATRIX_MCP_HARNESS: "claude_code" },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const services = JSON.stringify((await client.callTool({ name: "list_services" })).content);
      expect(services).toContain('\\"service\\": \\"linear\\"');
      const search = JSON.stringify((await client.callTool({ name: "search_tools", arguments: { query: "issues" } })).content);
      expect(search).toContain("linear.list_issues");
      expect(search).toContain("docs.search_docs");

      const listed = await client.callTool({ name: "call_tool", arguments: { service: "linear", tool: "linear.list_issues", arguments: { team: "SECRET-TEAM" } } });
      expect(listed.isError).toBeFalsy();
      expect(JSON.stringify(listed.content)).toContain("untrusted_external_content");
      expect(JSON.stringify(listed.content)).toContain("list_issues ok");
      const searched = await client.callTool({ name: "call_tool", arguments: { service: "docs", tool: "search_docs", arguments: { q: "private words" } } });
      expect(JSON.stringify(searched.content)).toContain("search_docs ok");
      const gated = await client.callTool({ name: "call_tool", arguments: { service: "linear", tool: "create_issue", arguments: { title: "x" } } });
      expect(gated.isError).toBe(true);
      expect(JSON.stringify(gated.content)).toContain("requires approval");
      expect(linear.calls.map(call => call.tool)).toEqual(["list_issues"]);
      expect(docs.calls.map(call => call.tool)).toEqual(["search_docs"]);

      await writer.drain();
      const rows = await usageDb.selectFrom("mcp_usage_events").selectAll().orderBy("id").execute();
      expect(rows.map(stored => [stored.server_key, stored.tool_name, stored.entry_point, stored.harness, stored.outcome, stored.actor_id])).toEqual([
        ["mcp.linear.test", "list_issues", "stdio", "claude_code", "ok", fixture.actorId],
        ["docs.example.test", "search_docs", "stdio", "claude_code", "ok", fixture.actorId],
        ["mcp.linear.test", "create_issue", "stdio", "claude_code", "approval_required", fixture.actorId],
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/SECRET-TEAM|private words|list_issues ok/);
    } finally {
      await client.close();
      registry.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
    }
  });
});
