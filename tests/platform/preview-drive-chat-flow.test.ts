import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createClaudeIntegrationApprovalControl } from "../../packages/gateway/src/chat/claude-integration-approval.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createPreviewDrivePlatformClient } from "../../packages/gateway/src/chat/preview-drive-platform-client.js";
import { createPreviewDriveWiring } from "../../packages/gateway/src/chat/preview-drive-wiring.js";
import { proxyIntegrationRequest } from "../../packages/gateway/src/integrations/platform-proxy.js";
import { getActivePreviewMachineByHandle } from "../../packages/platform/src/customer-vps-preview.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { authenticatedPreviewDriveProxyProof } from "../../packages/platform/src/preview-drive-proxy-proof.js";
import { createPreviewDriveRoutes } from "../../packages/platform/src/preview-drive-routes.js";
import { mintCustomMcpApprovalProof } from "../../packages/platform/src/custom-mcp-approval-proof.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const handle = "pr-1234";
const actorId = "user_drive_owner";
const secret = "test-platform-secret";
const body = { clientRequestId: "req_turn", baseRevision: 0,
  parts: [{ type: "text" as const, text: "List three of my Drive files" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
  interactionMode: "default" as const, permissionMode: "supervised" as const };
const action = { service: "google_drive", action: "list_files", label: "personal",
  params: { maxResults: 3 } };

describe("Preview browser-to-Claude Drive read", () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: "00000000-0000-4000-8000-000000002045",
      clerkUserId: "user_preview_owner", handle, runtimeSlot: handle,
      provisioningClass: "preview", accessClerkUserIds: [actorId, "user_other"], status: "running",
      provisionedAt: "2026-09-30T00:00:00.000Z" });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("requires a browser proof, executes one exact approval, and projects at most three metadata rows", async () => {
    const machine = await getActivePreviewMachineByHandle(db, handle);
    expect(machine).not.toBeNull();
    const browserTurn = new Request(`https://app.matrix-os.com/vm/${handle}/api/chats/chat_one/turns`, {
      method: "POST", body: JSON.stringify(body) });
    const turnProof = await authenticatedPreviewDriveProxyProof({
      request: browserTurn, method: "POST", path: "/api/chats/chat_one/turns",
      machine: machine!, identity: { handle, userId: actorId, source: "auth" }, platformSecret: secret,
    });
    // The real proxy forwards the original tee branch after minting its proof.
    await browserTurn.text();
    expect(typeof turnProof).toBe("string");

    const execute = vi.fn(async () => ({ files: [
      { id: "file_1", name: "one", secret: "not metadata" },
      { id: "file_2", name: "two" }, { id: "file_3", name: "three" }, { id: "file_4", name: "four" },
    ], nextPageToken: "not returned" }));
    const platform = new Hono();
    platform.route(`/internal/containers/:handle/preview-drive`, createPreviewDriveRoutes({ db,
      platformSecret: secret, integration: {
        listConnections: async id => id === actorId
          ? [{ service: "google_drive", account_label: "personal", status: "active" }] : [],
        execute,
      } }));
    const machineToken = createHmac("sha256", secret).update(handle).digest("hex");
    const platformFetch = vi.fn<typeof fetch>(async (url, init) => platform.request(String(url), init));
    const client = createPreviewDrivePlatformClient({ platformUrl: "https://platform.test", handle,
      machineToken, fetcher: platformFetch });
    const redeemBody = { actorId, chatId: "chat_one", turnId: "cturn_one", runId: "run_one",
      clientRequestId: body.clientRequestId, bodyDigest: "0".repeat(64) };
    const machineOnly = await platform.request(`https://platform.test/internal/containers/${handle}/preview-drive/turn/redeem`, {
      method: "POST", headers: { authorization: `Bearer ${machineToken}`, "content-type": "application/json" },
      body: JSON.stringify(redeemBody),
    });
    expect(machineOnly.status).toBe(403);

    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry, client });
    await wiring.beforeDispatch!({ actorId, chatId: "chat_one", turnId: "cturn_one", runId: "run_one",
      clientRequestId: body.clientRequestId, body, proof: turnProof as string });
    const capability = registry.issue({ owner: { type: "personal", ownerId: actorId },
      runId: "run_one", scope: "chat_call" })!;
    expect(capability.surface).toBe("preview_drive_call");
    await expect(client.redeemTurn({ ...redeemBody, proof: turnProof as string,
      bodyDigest: platformFetch.mock.calls[0] && JSON.parse(String(platformFetch.mock.calls[0][1]?.body)).bodyDigest }))
      .rejects.toThrow();

    const gateway = new Hono();
    gateway.use("*", authMiddleware("gateway-machine-token", {
      resolveMatrixMcpRunContext: registry.resolveRunContext }));
    const genericForward = vi.fn<typeof fetch>();
    gateway.all("*", c => proxyIntegrationRequest(c, {
      targetBase: "https://platform.test/internal/integrations", machineToken,
      fetcher: genericForward, previewDriveClient: client,
    }));
    const gatewayHeaders = { authorization: `Bearer ${capability.token}`, "content-type": "application/json" };
    const inventory = await gateway.request("/api/integrations", { headers: gatewayHeaders });
    expect(await inventory.json()).toEqual([{ service: "google_drive", account_label: "personal", status: "active" }]);
    const pending = await gateway.request("/api/integrations/call", { method: "POST", headers: gatewayHeaders,
      body: JSON.stringify(action) });
    expect(pending.status).toBe(403);

    const events: Array<{ type: string; approvalId?: string; actionDigest?: string }> = [];
    const respond = vi.fn(async (_value: unknown) => {});
    const control = createClaudeIntegrationApprovalControl({ runId: "run_one", homePath: "/safe/home",
      capability, previewDriveClient: client, emit: event => events.push(event), onError: vi.fn() });
    expect(control.onToolPermission({ nativeRequestId: "native_one",
      toolName: "mcp__matrix-integrations__call_service", input: action }, respond)).toBe(true);
    const requested = events[0]!;
    expect(requested.actionDigest).toMatch(/^[a-f0-9]{64}$/);
    const approvalBody = { clientRequestId: "req_approval", decision: "approve", actionDigest: requested.actionDigest };
    const approvalProof = mintCustomMcpApprovalProof({ method: "POST",
      path: `/api/chats/chat_one/runs/run_one/approvals/${requested.approvalId}`,
      identity: { handle, userId: actorId, source: "auth" }, body: JSON.stringify(approvalBody), secret });
    await control.submit(requested.approvalId!, "approve", { chatId: "chat_one",
      clientRequestId: approvalBody.clientRequestId, platformApprovalProof: approvalProof! });
    const receipt = (respond.mock.calls[0]![0] as { updatedInput: { matrix_approval_receipt: string } })
      .updatedInput.matrix_approval_receipt;
    const approved = await gateway.request("/api/integrations/call", { method: "POST",
      headers: { ...gatewayHeaders, "x-matrix-integration-approval": receipt }, body: JSON.stringify(action) });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ service: "google_drive", action: "list_files",
      data: { files: [{ id: "file_1", name: "one" }, { id: "file_2", name: "two" },
        { id: "file_3", name: "three" }] } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(actorId, "personal", { maxResults: 3 });
    expect((await gateway.request("/api/integrations/call", { method: "POST",
      headers: { ...gatewayHeaders, "x-matrix-integration-approval": receipt },
      body: JSON.stringify(action) })).status).toBe(403);
    expect(genericForward).not.toHaveBeenCalled();
  });
});
