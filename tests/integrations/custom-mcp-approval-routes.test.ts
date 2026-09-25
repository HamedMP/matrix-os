import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { createCustomMcpApprovalRoutes } from "../../packages/gateway/src/integrations/custom-mcp/approval-routes.js";
import { mintCustomMcpApprovalProof, verifyCustomMcpApprovalProof } from "../../packages/platform/src/custom-mcp-approval-proof.js";

const serverId = "123e4567-e89b-42d3-a456-426614174000";
const approvalId = "123e4567-e89b-42d3-a456-426614174001";

describe("server-only Custom MCP approval routes", () => {
  it("derives actor and owner from machine context, and rejects caller-supplied identity", async () => {
    const register = vi.fn(async () => ({ id: "123e4567-e89b-42d3-a456-426614174002" }));
    const reserve = vi.fn(async () => ({ kind: "pending" as const, approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const decide = vi.fn(async () => ({ receipt: "a".repeat(64) }));
    const revoke = vi.fn(async () => true);
    const db = {
      registerCustomMcpRunLease: register,
      decideCustomMcpToolApproval: decide,
      revokeCustomMcpRunLease: revoke,
    } as unknown as PlatformDb;
    const broker = { prepareToolApproval: reserve } as unknown as CustomMcpBroker;
    const app = new Hono();
    app.route("/internal", createCustomMcpApprovalRoutes({ db, broker,
      verifyDecisionProof: (proof, input) => verifyCustomMcpApprovalProof(proof, { ...input, secret: "platform-secret-fixture" }),
      resolvePrincipal: async () => ({ userId: "owner-uuid", actorId: "clerk-owner", handle: "owner" }) }));
    const post = (path: string, body: unknown, proof?: string) => app.request(`/internal${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(proof ? { "x-matrix-custom-mcp-approval-proof": proof } : {}) }, body: JSON.stringify(body),
    });

    expect((await post("/runs", { runId: "run_owner", actorId: "forged" })).status).toBe(400);
    expect((await post("/runs", { runId: "run_owner" })).status).toBe(200);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-uuid", actorId: "clerk-owner", runId: "run_owner",
    }));
    const prepared = await post("/runs/run_owner/prepare", {
      nativeRequestId: "native_1", serverId, tool: "publish", arguments: { content: "fixture" },
    });
    expect(prepared.status).toBe(200);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-uuid", actorId: "clerk-owner", runId: "run_owner", serverId,
    }));
    expect((await post(`/runs/run_owner/decisions/${approvalId}`, { decision: "approve_for_session" })).status).toBe(400);
    const decisionBody = { decision: "approve", chatId: "chat_owner", clientRequestId: "req_1" };
    expect((await post(`/runs/run_owner/decisions/${approvalId}`, decisionBody)).status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
    const proof = mintCustomMcpApprovalProof({ method: "POST", path: `/api/chats/chat_owner/runs/run_owner/approvals/${approvalId}`,
      identity: { handle: "owner", userId: "clerk-owner", source: "auth" },
      body: JSON.stringify({ decision: "approve", clientRequestId: "req_1" }), secret: "platform-secret-fixture" })!;
    expect((await post(`/runs/run_owner/decisions/${approvalId}`, decisionBody, proof)).status).toBe(200);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-uuid", actorId: "clerk-owner", runId: "run_owner", approvalId,
    }));
    expect((await post("/runs/run_owner/revoke", {})).status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-uuid", actorId: "clerk-owner", runId: "run_owner",
    }));
  });
});
