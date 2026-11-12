/**
 * Layer-4 integration checkpoint (spec 2691): a write from an external `/mcp`
 * client stays pending until the owner approves it in Matrix, then executes
 * exactly once. Real pieces: the platform `/mcp` route and Streamable HTTP
 * transport, the Core tool service, the broker, the approval store (PGlite),
 * the owner-session decision route, and the upstream MCP client. Only OAuth
 * token verification and the upstream network edge are faked.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreToolService } from "../../packages/gateway/src/integrations/custom-mcp/core-tools.js";
import type { CoreUsageRecord } from "../../packages/gateway/src/integrations/custom-mcp/core-usage.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import { EXTERNAL_RUN_WINDOW_MS, externalClientKey, externalLeaseExpiry, externalRunIds } from "../../packages/gateway/src/integrations/custom-mcp/external-approval-store.js";
import { McpAuthError } from "../../packages/platform/src/mcp-auth.js";
import { registerExternalCoreMcpTools, type ExternalCoreToolService } from "../../packages/platform/src/mcp-core-tools.js";
import { createMcpRoutes } from "../../packages/platform/src/mcp-routes.js";
import { createCoreFixture, type CoreFixture, type FakeUpstream } from "./core-mcp-fixture.js";

const resourceUrl = "https://app.matrix-os.test/mcp";

describe("external Matrix Core MCP write approvals", () => {
  let fixture: CoreFixture;
  let linear: FakeUpstream;
  let usage: CoreUsageRecord[];
  let mcp: Hono;
  let owner: Hono;
  let internal: Hono;

  beforeEach(async () => {
    linear = { host: "mcp.linear.test", calls: [], tools: [
      { name: "list_issues", description: "List Linear issues." },
      { name: "create_issue", description: "Create a Linear issue." },
    ] };
    fixture = await createCoreFixture([linear]);
    await fixture.connect("Linear", linear.host, { list_issues: "allow", create_issue: "always_ask" });
    usage = [];
    const core = new CoreToolService({ broker: fixture.broker, approvals: fixture.db, usage: { record: row => { usage.push(row); } } });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const principals: Record<string, { userId: string; clientId: string; expiresAt: number }> = {
      "client-a": { userId: fixture.actorId, clientId: "claude-code", expiresAt },
      "client-b": { userId: fixture.actorId, clientId: "other-client", expiresAt },
    };
    mcp = new Hono().route("/", createMcpRoutes({ resourceUrl, issuer: "https://login.matrix-os.test",
      verify: async token => { const principal = principals[token]; if (!principal) throw new McpAuthError("invalid_token"); return principal; },
      context: () => ({ listComputers: async () => ({ items: [], selectedSlot: null, hasMore: false, limit: 20 }),
        resolveRuntime: async () => { throw new Error("no computers in this fixture"); } }) as never,
      extendServer: async (server, principal, signal) => registerExternalCoreMcpTools(server, {
        core: core as unknown as ExternalCoreToolService, principal, signal,
        userId: principal.userId === fixture.actorId ? fixture.userId : null }) }));
    owner = new Hono().route("/api/mcp-servers", createCustomMcpRoutes({ broker: fixture.broker,
      resolveUserId: async () => fixture.userId, ownerApprovals: fixture.db }));
    internal = new Hono().route("/api/mcp-servers", createCustomMcpRoutes({ broker: fixture.broker, core, allowToolCalls: true,
      resolveUserId: async () => fixture.userId, resolveActorId: () => fixture.actorId }));
  });
  afterEach(async () => { await fixture.close(); });

  async function tool(token: string, name: string, args: Record<string, unknown>) {
    const response = await mcp.request(resourceUrl, { method: "POST", headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, text: body.result.content[0]!.text };
  }

  it("keeps the write pending until the owner approves, then executes it exactly once", async () => {
    const create = { service: "linear", tool: "create_issue", arguments: { title: "From Codex" } };
    const pending = await tool("client-a", "call_tool", create);
    expect(pending.isError).toBe(false);
    const { status, approvalId } = JSON.parse(pending.text) as { status: string; approvalId: string };
    expect(status).toBe("pending_approval");
    expect(linear.calls).toEqual([]);

    // The client cannot proceed on its own say-so.
    expect((await tool("client-a", "call_tool", { ...create, approval_id: approvalId })).isError).toBe(true);
    expect(JSON.parse((await tool("client-a", "get_approval", { approval_id: approvalId })).text)).toMatchObject({ status: "pending", tool: "create_issue" });
    // A different OAuth client of the same owner cannot see or use it.
    expect((await tool("client-b", "get_approval", { approval_id: approvalId })).isError).toBe(true);
    // The run/VPS router has no approve action at all.
    expect((await internal.request(`/api/mcp-servers/core/external-approvals/${approvalId}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) })).status).toBe(404);
    expect(linear.calls).toEqual([]);

    const listed = await (await owner.request("/api/mcp-servers/core/external-approvals")).json() as { approvals: Array<Record<string, unknown>> };
    expect(listed.approvals).toEqual([expect.objectContaining({ approvalId, service: "linear", tool: "create_issue" })]);
    expect(JSON.stringify(listed)).not.toContain("From Codex");
    const approved = await owner.request(`/api/mcp-servers/core/external-approvals/${approvalId}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
    expect(await approved.json()).toEqual({ status: "approved" });
    expect(JSON.parse((await tool("client-a", "get_approval", { approval_id: approvalId })).text)).toMatchObject({ status: "approved" });

    // Approval binds the arguments: altered arguments and another client are refused.
    expect((await tool("client-a", "call_tool", { ...create, arguments: { title: "Altered" }, approval_id: approvalId })).isError).toBe(true);
    expect((await tool("client-b", "call_tool", { ...create, approval_id: approvalId })).isError).toBe(true);
    expect(linear.calls).toEqual([]);

    const executed = await tool("client-a", "call_tool", { ...create, approval_id: approvalId });
    expect(executed.isError).toBe(false);
    expect(executed.text).toContain("untrusted_external_content");
    expect((await tool("client-a", "call_tool", { ...create, approval_id: approvalId })).isError).toBe(true);
    expect(linear.calls).toEqual([{ tool: "create_issue", args: { title: "From Codex" } }]);
    expect(usage.filter(row => row.toolName === "create_issue").map(row => [row.entryPoint, row.outcome]))
      .toEqual(expect.arrayContaining([["external_mcp", "approval_required"], ["external_mcp", "ok"]]));
    expect(usage.every(row => row.entryPoint === "external_mcp")).toBe(true);
  });

  it("runs allow-policy tools directly and lets the owner decline a pending write", async () => {
    expect((await tool("client-a", "call_tool", { service: "linear", tool: "list_issues" })).isError).toBe(false);
    expect(linear.calls).toEqual([{ tool: "list_issues", args: {} }]);
    const services = JSON.parse((await tool("client-a", "list_services", {})).text) as { services: Array<{ service: string }> };
    expect(services.services.map(entry => entry.service)).toEqual(["linear"]);

    const create = { service: "linear", tool: "create_issue", arguments: { title: "Declined" } };
    const { approvalId } = JSON.parse((await tool("client-a", "call_tool", create)).text) as { approvalId: string };
    const declined = await owner.request(`/api/mcp-servers/core/external-approvals/${approvalId}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "decline" }) });
    expect(await declined.json()).toEqual({ status: "denied" });
    expect((await owner.request(`/api/mcp-servers/core/external-approvals/${approvalId}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) })).status).toBe(409);
    expect((await tool("client-a", "call_tool", { ...create, approval_id: approvalId })).isError).toBe(true);
    expect(linear.calls).toHaveLength(1);
  });

  it("keeps a full 10-minute approval TTL at any point of a lease window and finds it after rotation", () => {
    // Fault: a late-window approval is cut short by its lease, or the retry looks in the wrong window.
    const key = externalClientKey("user-1", "claude-code");
    expect(key).not.toBe(externalClientKey("user-1", "other-client"));
    for (const offset of [0, EXTERNAL_RUN_WINDOW_MS - 1]) {
      const created = 40 * EXTERNAL_RUN_WINDOW_MS + offset;
      expect(externalLeaseExpiry(created).getTime() - created).toBeGreaterThanOrEqual(10 * 60_000);
      expect(externalLeaseExpiry(created).getTime() - created).toBeLessThanOrEqual(35 * 60_000);
      const [leaseRun] = externalRunIds(key, created);
      expect(externalRunIds(key, created + 10 * 60_000)).toContain(leaseRun);
    }
  });
});
