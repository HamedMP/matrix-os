/**
 * Spec 2691 layer 4: Claude Code's permission hook prepares Matrix Core
 * call_tool approvals by service slug. The real approval routes, broker,
 * approval store (PGlite), and Core service consume the resulting receipt.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCustomMcpApprovalRoutes } from "../../packages/gateway/src/integrations/custom-mcp/approval-routes.js";
import { CoreToolService } from "../../packages/gateway/src/integrations/custom-mcp/core-tools.js";
import { createCoreFixture, type CoreFixture, type FakeUpstream } from "./core-mcp-fixture.js";

describe("Claude Code Core call_tool approvals by service slug", () => {
  let fixture: CoreFixture;
  let linear: FakeUpstream;
  let app: Hono;

  beforeEach(async () => {
    linear = { host: "mcp.linear.test", calls: [], tools: [
      { name: "list_issues", description: "List Linear issues." },
      { name: "create_issue", description: "Create a Linear issue." },
    ] };
    fixture = await createCoreFixture([linear]);
    await fixture.connect("Linear", linear.host, { list_issues: "allow", create_issue: "always_ask" });
    app = new Hono();
    app.route("/approvals", createCustomMcpApprovalRoutes({ db: fixture.db, broker: fixture.broker,
      resolvePrincipal: async () => ({ userId: fixture.userId, actorId: fixture.actorId, handle: "coreowner" }),
      verifyDecisionProof: proof => proof === "signed-fixture" }));
  });
  afterEach(async () => { await fixture.close(); });

  const post = (path: string, body: unknown, proof?: string) => app.request(`/approvals${path}`, { method: "POST",
    headers: { "content-type": "application/json", ...(proof ? { "x-matrix-custom-mcp-approval-proof": proof } : {}) },
    body: JSON.stringify(body) });

  it("reserves a pending approval for service + namespaced tool and lets exactly one Core call consume it", async () => {
    const registered = await (await post("/runs", { runId: "run_claude" })).json() as { generation: number };
    const prepared = await post("/runs/run_claude/prepare", { generation: registered.generation, nativeRequestId: "native_1",
      service: "linear", tool: "linear.create_issue", arguments: { title: "Fixture" } });
    expect(prepared.status).toBe(200);
    const pending = await prepared.json() as { kind: string; approvalId: string };
    expect(pending.kind).toBe("pending");
    const decided = await post(`/runs/run_claude/decisions/${pending.approvalId}`,
      { decision: "approve", chatId: "chat_1", clientRequestId: "req_1" }, "signed-fixture");
    const { receipt } = await decided.json() as { receipt: string };
    const core = new CoreToolService({ broker: fixture.broker, approvals: fixture.db });
    const caller = { userId: fixture.userId, actorId: fixture.actorId, runId: "run_claude", entryPoint: "stdio" as const, harness: "claude_code" };
    const call = { service: "linear", tool: "create_issue", arguments: { title: "Fixture" }, approvalReceipt: receipt };
    await expect(core.callTool(caller, call)).resolves.toMatchObject({ status: "ok" });
    await expect(core.callTool(caller, call)).rejects.toThrow();
    expect(linear.calls).toEqual([{ tool: "create_issue", args: { title: "Fixture" } }]);
  });

  it("allows an allow-policy tool without a pending approval and refuses an unknown service", async () => {
    const { generation } = await (await post("/runs", { runId: "run_allow" })).json() as { generation: number };
    expect(await (await post("/runs/run_allow/prepare", { generation, nativeRequestId: "native_allow",
      service: "linear", tool: "list_issues" })).json()).toEqual({ kind: "allow" });
    expect((await post("/runs/run_allow/prepare", { generation, nativeRequestId: "native_missing",
      service: "github", tool: "list_issues" })).status).toBe(403);
    expect((await post("/runs/run_allow/prepare", { generation, nativeRequestId: "native_both", serverId: "123e4567-e89b-42d3-a456-426614174000",
      service: "linear", tool: "list_issues" })).status).toBe(400);
  });
});
