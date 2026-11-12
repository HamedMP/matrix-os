import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedPiMcpClient } from "../../packages/gateway/src/chat/managed-pi-mcp-client.js";
import { CoreToolService } from "../../packages/gateway/src/integrations/custom-mcp/core-tools.js";
import type { CoreUsageRecord } from "../../packages/gateway/src/integrations/custom-mcp/core-usage.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import { createCoreFixture, type CoreFixture, type FakeUpstream } from "./core-mcp-fixture.js";

describe("managed Pi reaches the Matrix Core MCP through the platform transport", () => {
  let fixture: CoreFixture;
  let upstream: FakeUpstream;
  let usage: CoreUsageRecord[];
  let linearId: string;

  beforeEach(async () => {
    upstream = { host: "mcp.linear.test", calls: [], tools: [
      { name: "list_issues", description: "List Linear issues." },
      { name: "archive_issue", description: "Archive a Linear issue." },
    ] };
    fixture = await createCoreFixture([upstream]);
    usage = [];
    linearId = await fixture.connect("Linear", upstream.host, { list_issues: "allow", archive_issue: "blocked" });
  });
  afterEach(async () => { await fixture.close(); });

  it("searches by intent, then calls the hit's server through mcp_call with a managed_pi usage row", async () => {
    const core = new CoreToolService({ broker: fixture.broker, usage: { record: row => usage.push(row) } });
    const platform = new Hono();
    platform.route("/internal/containers/owner/mcp-servers", createCustomMcpRoutes({ broker: fixture.broker, core,
      allowToolCalls: true, resolveUserId: async () => fixture.userId, resolveActorId: () => fixture.actorId }));
    const client = createManagedPiMcpClient({ platformUrl: "https://platform.example.test", handle: "owner",
      token: "machine-fixture", ownerId: fixture.actorId, fetcher: (url, init) => platform.request(url, init) });
    const signal = new AbortController().signal;

    const found = await client.search(fixture.actorId, { query: "issues" }, signal) as {
      results: Array<{ serverId: string; qualifiedName: string; approval: string }>; skipped: unknown[];
    };
    expect(found.results.map(hit => [hit.qualifiedName, hit.approval])).toEqual([[`linear-${linearId.slice(0, 8)}.list_issues`, "allow"]]);
    await expect(client.search(fixture.actorId, { query: "issues", service: "missing" }, signal)).rejects.toThrow("MCP unavailable");

    const result = await client.call(fixture.actorId, { serverId: found.results[0]!.serverId, tool: "list_issues",
      arguments: { team: "ENG" }, runId: "run_pi" }, signal);
    expect(result).toEqual({ content: [{ type: "text", text: "list_issues ok" }] });
    expect(upstream.calls).toEqual([{ tool: "list_issues", args: { team: "ENG" } }]);
    expect(usage.map(row => [row.entryPoint, row.harness, row.toolName, row.outcome])).toEqual([["managed_pi", "pi", "list_issues", "ok"]]);
  });
});
