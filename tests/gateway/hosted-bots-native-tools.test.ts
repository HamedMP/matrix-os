import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createHostedBotsDriveApproval } from "../../packages/gateway/src/hosted-bots/drive-approval.js";
import { bindHostedBotsDriveSocket } from "../../packages/gateway/src/hosted-bots/drive-approval-runtime.js";
import type { HostedBotsCustomMcpDependencies } from "../../packages/gateway/src/hosted-bots/custom-mcp-approval.js";
import { mintCustomMcpApprovalProof, verifyCustomMcpApprovalProof } from "../../packages/platform/src/custom-mcp-approval-proof.js";
// @ts-expect-error The isolated Node helper ships as-is.
import { mcpToolReply } from "../../scripts/openmausbot/matrix-drive-mcp.mjs";

const ownerId = "user_native_tools";
const serverId = "d60dd0fa-1362-48ea-8d25-bcc58a400e39";
const approvalId = "058c21bc-88bf-4bb4-81fa-cbaf40244afe";
const id = "a28367ea-1b43-4838-b4a7-50c0617ee753";
const input = { serverId, tool: "fixture_lookup", arguments: { query: "test" } };
const tool = { name: input.tool, description: "Look up a fixture", inputSchema: { type: "object" }, approval: "always_ask" };
const server = { id: serverId, name: "Fixture MCP", enabled: true, status: "ready", tools: [tool] };
const account = { connectionId: "account-private-123", service: "google_drive", label: "Private name", email: "fixture@example.invalid" };
const headers = { "content-type": "application/json" };
const userHeaders = { ...headers, "x-test-owner": ownerId };

function fixture() {
  const integration = {
    inventory: vi.fn(async () => [account]),
    catalog: vi.fn(async () => [{ id: account.service, actions: [
      { id: "read_file", risk: "read" as const, description: "Read one file", params: { fileId: { type: "string" as const } } },
      { id: "not_in_registry", risk: "read" as const, description: "Unknown", params: {} },
    ] }]),
    describe: vi.fn(),
    call: vi.fn(),
  };
  const customMcp = {
    client: {
      inventory: vi.fn(async () => [server, { ...server, id, name: "Offline server", enabled: false }]),
      describe: vi.fn(async () => ({ ...server, url: "https://private.example.invalid", authorization: "secret" })),
      call: vi.fn(async () => ({ content: [{ type: "text", text: "fixture" }] })),
    },
    approvals: {
      verifyIntegrationDecision: vi.fn<NonNullable<HostedBotsCustomMcpDependencies["approvals"]["verifyIntegrationDecision"]>>(
        async ({ platformApprovalProof, ...tuple }) => verifyCustomMcpApprovalProof(platformApprovalProof, {
          ...tuple, handle: "dev-fixture", actorId: ownerId, secret: "fixture",
        }),
      ),
      registerRun: vi.fn(async () => ({ generation: 1 })),
      prepare: vi.fn<HostedBotsCustomMcpDependencies["approvals"]["prepare"]>(async () =>
        ({ kind: "pending", approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() })),
      decide: vi.fn<HostedBotsCustomMcpDependencies["approvals"]["decide"]>(async (runId, approvalId, decision, proof) => {
        if (!proof || !verifyCustomMcpApprovalProof(proof.platformApprovalProof, {
          handle: "dev-fixture", actorId: ownerId, chatId: proof.chatId, clientRequestId: proof.clientRequestId,
          runId, approvalId, decision, secret: "fixture",
        })) throw new Error("Unverified approval");
        return decision === "approve" ? { receipt: "a".repeat(64) } : {};
      }),
      revokeRun: vi.fn(async () => true),
    },
  };
  const broker = createHostedBotsDriveApproval({
    admitted: true, ownerId, isOwner: c => c.req.header("x-test-owner") === ownerId,
    customMcp, integration, timeoutMs: 5_000,
  });
  const shell = new Hono().route("/api/chats/hosted-bots", broker.mcpDecisionRoutes)
    .route("/api/hosted-bots/integrations", broker.integrationOwnerRoutes);
  const waitForRequest = (expectedId?: string) => vi.waitFor(async () => {
      const result = await shell.request("/api/hosted-bots/integrations/mcp", { headers: userHeaders });
      expect(result.status).toBe(200);
      const snapshot = await result.json();
      expect(snapshot.requests[0]?.id).toEqual(expectedId ?? expect.any(String));
      return snapshot.requests[0] as { runId: string; id: string };
  });
  const pending = async (signal?: AbortSignal, expectedId?: string) => {
    const response = broker.guestRoutes.request("/mcp/call", { method: "POST", headers, body: JSON.stringify(input), signal });
    return { request: await waitForRequest(expectedId), response };
  };
  const decide = (runId: string, approval: string, decision: "approve" | "decline", { signed = true, owner = true } = {}) => {
    const path = `/api/chats/hosted-bots/runs/${runId}/approvals/${approval}`;
    const body = JSON.stringify({ clientRequestId: "req_" + id, decision });
    const proof = mintCustomMcpApprovalProof({
      method: "POST", path, body, identity: { userId: ownerId, handle: "dev-fixture", source: "auth" }, secret: "fixture",
    });
    return shell.request(path, { method: "POST", body, headers: {
      ...(owner ? userHeaders : headers), ...(signed ? { "x-matrix-custom-mcp-approval-proof": proof! } : {}),
    } });
  };
  return { integration, customMcp, broker, shell, pending, decide, waitForRequest };
}

describe("Matrix native tools inside hosted Bots", () => {
  it("discovers only supported connected actions and enabled MCP tools, without exposing account, URL, or credentials", async () => {
    const f = fixture();
    try {
      const app = await f.broker.guestRoutes.request("/integration/catalog");
      expect(app.status).toBe(200);
      const apps = await app.text();
      expect(JSON.parse(apps).services).toEqual([{
        id: "google_drive",
        actions: [{ id: "read_file", description: expect.any(String), params: { fileId: expect.objectContaining({ type: "string" }) } }],
      }]);
      expect(apps).not.toContain(account.connectionId);
      expect(apps).not.toContain(account.email);
      const mcp = await f.broker.guestRoutes.request("/mcp/catalog");
      expect(await mcp.json()).toEqual({ servers: [{ id: serverId, name: server.name, tools: [tool] }] });
      expect((await f.shell.request("/api/hosted-bots/integrations/mcp")).status).toBe(403);
    } finally { f.broker.close(); }
  });

  it("dispatches exact arguments with a Matrix receipt only after a signed owner decision", async () => {
    const f = fixture();
    try {
      const { request, response } = await f.pending(undefined, approvalId);
      expect(request.runId).toMatch(/^hosted-bots-/);
      expect((await f.decide(request.runId, request.id, "approve", { owner: false })).status).toBe(403);
      expect((await f.decide(request.runId, request.id, "approve", { signed: false })).status).toBe(403);
      expect(f.customMcp.client.call).not.toHaveBeenCalled();
      expect((await f.decide(request.runId, request.id, "approve")).status).toBe(202);
      expect(await (await response).json()).toEqual({ data: { content: [{ type: "text", text: "fixture" }] } });
      expect(f.customMcp.client.call).toHaveBeenCalledExactlyOnceWith(ownerId, {
        ...input, runId: request.runId, approvalReceipt: "a".repeat(64),
      }, expect.any(AbortSignal), expect.any(Function));
      expect(f.customMcp.approvals.revokeRun).toHaveBeenCalledWith(request.runId);
    } finally { f.broker.close(); }
  });

  it("does not call the stored MCP server after denial or cancellation", async () => {
    const f = fixture();
    try {
      const { request, response } = await f.pending();
      expect((await f.decide(request.runId, request.id, "decline")).status).toBe(202);
      expect((await response).status).toBe(403);
      expect(f.customMcp.client.call).not.toHaveBeenCalled();
      expect(f.customMcp.approvals.revokeRun).toHaveBeenCalledWith(request.runId);
      const cancel = new AbortController();
      const second = await f.pending(cancel.signal);
      cancel.abort();
      expect((await second.response).status).toBe(403);
      expect(f.customMcp.client.call).not.toHaveBeenCalled();
      expect(f.customMcp.approvals.revokeRun).toHaveBeenCalledWith(second.request.runId);
    } finally { f.broker.close(); }
  });

  it("verifies the human decision for stored Allow tools rather than accepting a proof-shaped header", async () => {
    const f = fixture();
    try {
      f.customMcp.approvals.prepare.mockResolvedValueOnce({ kind: "allow" });
      const { request, response } = await f.pending();
      const path = `/api/chats/hosted-bots/runs/${request.runId}/approvals/${request.id}`;
      const fake = await f.shell.request(path, {
        method: "POST",
        headers: { ...userHeaders, "x-matrix-custom-mcp-approval-proof": "fake." + "a".repeat(64) },
        body: JSON.stringify({ decision: "approve", clientRequestId: "req_" + id }),
      });
      expect(fake.status).toBe(403);
      expect(f.customMcp.client.call).not.toHaveBeenCalled();
      expect((await f.decide(request.runId, request.id, "approve")).status).toBe(202);
      expect((await response).status).toBe(200);
      expect(f.customMcp.client.call).toHaveBeenCalledExactlyOnceWith(ownerId, {
        ...input, runId: request.runId,
      }, expect.any(AbortSignal), expect.any(Function));
    } finally { f.broker.close(); }
  });

  it("returns the real Custom MCP result through the hosted Unix tool helper", async () => {
    const f = fixture();
    const directory = await mkdtemp("/tmp/matrix-bots-native-tools-");
    const path = join(directory, "tools.sock");
    let close: (() => Promise<void>) | undefined;
    try {
      close = await bindHostedBotsDriveSocket(path, f.broker.guestRoutes);
      const tool = mcpToolReply(input, path);
      const request = await f.waitForRequest(approvalId);
      expect((await f.decide(request.runId, request.id, "approve")).status).toBe(202);
      const reply = await tool;
      expect(reply.isError).toBeUndefined();
      expect(JSON.parse(reply.content[0].text)).toEqual({ data: { content: [{ type: "text", text: "fixture" }] } });
    } finally {
      f.broker.close();
      await close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
