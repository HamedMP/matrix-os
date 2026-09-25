import { Hono, type Context } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createClaudeCustomMcpApprovalControl } from "../../packages/gateway/src/chat/claude-custom-mcp-approval.js";
import { createCustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { registerCustomMcpGatewayRoutes } from "../../packages/gateway/src/integrations/custom-mcp/gateway-routes.js";
import { createCustomMcpApprovalRoutes } from "../../packages/gateway/src/integrations/custom-mcp/approval-routes.js";
import { integrationProxyHeaders } from "../../packages/gateway/src/integrations/custom-mcp/proxy-headers.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import type { CustomMcpServerProjection } from "../../packages/gateway/src/integrations/custom-mcp/types.js";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createApp } from "../../packages/platform/src/main.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createInternalCustomMcpApprovalRouteOptions } from "../../packages/platform/src/custom-mcp-approval-route-options.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { cleanupProxyRoutingTest, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

const secret = "platform-secret-123";
const handle = "alice-primary";
const actorId = "user_alice";
const runId = "run_1";
const chatId = "chat_1";
const args = { document: "public synthetic fixture" };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("authenticated canonical Custom MCP approval chain", () => {
  let routingDb: PlatformDB;
  let approvalDb: PlatformDb;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (approvalDb) await approvalDb.destroy();
    if (routingDb) await cleanupProxyRoutingTest(routingDb);
  });

  it("requires a Platform-authenticated user decision before one remote call", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    routingDb = await setupProxyRoutingTest();
    await insertUserMachine(routingDb, {
      machineId: "machine-alice-primary", clerkUserId: actorId, handle,
      runtimeSlot: "primary", status: "running", hetznerServerId: 100,
      publicIPv4: "203.0.113.20", imageVersion: "dev", serverType: "cpx22",
      provisionedAt: "2026-09-25T00:00:00.000Z",
    });
    const pglite = await KyselyPGlite.create();
    approvalDb = createPlatformDb({ dialect: pglite.dialect });
    await approvalDb.migrate();
    const userId = (await approvalDb.createUser({ clerkId: actorId, handle,
      displayName: "Fixture", email: "owner@example.test", containerId: "fixture-container" })).id;
    const created = await approvalDb.createCustomMcpServer({ userId, name: "Fixture",
      url: "https://mcp.example.test/mcp", authMode: "none", pendingExpiresAt: new Date(Date.now() + 60_000) });
    const serverId = created.id;
    await approvalDb.updateCustomMcpServer(serverId, userId, created.revision, {
      enabled: true, status: "ready", tools: [{ name: "publish", description: "Publish fixture",
        inputSchema: { type: "object" }, enabled: true, approval: "always_ask" }],
    });
    const projection: CustomMcpServerProjection = { id: serverId, name: "Fixture", url: created.url,
      authMode: "none", enabled: true, revision: 2,
      tools: [{ name: "publish", enabled: true, approval: "always_ask" }] };
    const remoteCall = vi.fn(async () => ({ marker: "synthetic-result" }));
    const broker = new CustomMcpBroker({ db: approvalDb, encryptionKey: Buffer.alloc(32),
      projection: { upsert: vi.fn(), remove: vi.fn(), read: vi.fn(async () => projection) },
      client: { callTool: remoteCall } as unknown as RemoteMcpClient });
    const machineToken = buildPlatformVerificationToken(handle, secret);
    const platform = createApp({ db: routingDb, orchestrator: stubOrchestrator(), platformSecret: secret,
      internalCustomMcpRoutes: createCustomMcpRoutes({ broker, allowToolCalls: true,
        resolveUserId: async () => userId,
        resolveActorId: context => context.get("internalContainerClerkUserId") as string | null }),
      internalCustomMcpApprovalRoutes: createCustomMcpApprovalRoutes(createInternalCustomMcpApprovalRouteOptions({
        db: approvalDb, broker, platformSecret: secret,
        resolveUserId: async (actor, machineHandle) => actor === actorId && machineHandle === handle ? userId : null,
      })),
    });
    const approvalClient = createCustomMcpApprovalClient({ platformUrl: "https://platform.example.test",
      handle, token: machineToken, fetcher: (url, init) => platform.request(url, init) });
    expect(await approvalClient.registerRun(runId)).toBe(true);
    const events: Array<{ type: string; approvalId?: string }> = [];
    const nativeResponses: Array<{ behavior: string; updatedInput?: Record<string, unknown> }> = [];
    const control = createClaudeCustomMcpApprovalControl({ runId, client: approvalClient,
      emit: event => events.push(event), onError: error => { throw error; } });
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: actorId });
    const capability = registry.issue({ owner: { type: "personal", ownerId: actorId }, runId, scope: "call" })!;
    const gateway = new Hono();
    gateway.use("*", authMiddleware(machineToken, { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    gateway.route("/", createCanonicalChatRoutes({
      service: { submitApproval: async (owner, requestedChatId, requestedRunId, approvalId, input, provenance) => {
        expect(owner).toEqual({ type: "personal", ownerId: actorId });
        expect([requestedChatId, requestedRunId]).toEqual([chatId, runId]);
        await control.submit(approvalId, input.decision, { chatId, clientRequestId: input.clientRequestId,
          platformApprovalProof: provenance?.platformApprovalProof });
        return { approvalId, decision: input.decision, submission: "accepted" };
      } } as CanonicalChatRouteService,
      getPrincipal: context => requireRequestPrincipal(context),
    }));
    registerCustomMcpGatewayRoutes(gateway, { homePath: "/tmp/custom-mcp-approval-fixture",
      platformProxy: { internalPlatformUrl: "https://platform.example.test", handle,
        token: machineToken, request: async (context: Context) => {
          const headers = integrationProxyHeaders(context, "/api/mcp-servers");
          headers.set("authorization", `Bearer ${machineToken}`);
          headers.set("content-type", "application/json");
          return platform.request(`/internal/containers/${handle}${context.req.path.slice(4)}`, {
            method: context.req.method,
            headers,
            body: await context.req.text(),
          });
        } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      return gateway.request(path, init);
    });
    const toolInput = { server_id: serverId, tool: "publish", arguments: args };
    control.onToolPermission({ nativeRequestId: "native_1",
      toolName: "mcp__matrix-integrations__call_custom_mcp_tool", input: toolInput },
    async value => { nativeResponses.push(value as typeof nativeResponses[number]); });
    await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
    const approvalId = events[0]!.approvalId!;
    const call = (receipt?: string) => gateway.request(`/api/mcp-servers/${serverId}/call`, {
      method: "POST", headers: { authorization: `Bearer ${capability.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "publish", arguments: args, approvalGranted: false,
        ...(receipt ? { approvalReceipt: receipt } : {}) }),
    });
    expect(registry.resolveRunContext(capability.token, "POST", `/api/mcp-servers/${serverId}/call`)).toMatchObject({ runId });
    expect((await call()).status).toBe(404);
    expect(remoteCall).not.toHaveBeenCalled();
    const machineOnlyDecision = await platform.request(
      `/internal/containers/${handle}/mcp-approvals/runs/${runId}/decisions/${approvalId}`,
      { method: "POST", headers: { authorization: `Bearer ${machineToken}`,
        "content-type": "application/json", "x-matrix-custom-mcp-approval-proof": "forged" },
      body: JSON.stringify({ decision: "approve", chatId, clientRequestId: "req_1" }) });
    expect(machineOnlyDecision.status).toBe(403);
    const session = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: actorId, handle,
      gatewayUrl: `https://app.matrix-os.com/vm/${handle}`, runtimeSlot: "primary" })).token;
    const canonicalPath = `/api/chats/${chatId}/runs/${runId}/approvals/${approvalId}`;
    const userDecision = await platform.request(canonicalPath, { method: "POST", headers: {
      host: "app.matrix-os.com", cookie: `matrix_app_session=${encodeURIComponent(session)}`,
      "content-type": "application/json", "x-matrix-chat-metadata": "1",
    }, body: JSON.stringify({ decision: "approve", clientRequestId: "req_1" }) });
    expect(userDecision.status).toBe(200);
    await flush();
    expect(events.at(-1)).toMatchObject({ type: "approval.resolved", approvalId });
    const receipt = nativeResponses[0]?.updatedInput?.approval_receipt as string;
    expect(receipt).toMatch(/^[a-f0-9]{64}$/);
    expect((await call(receipt)).status).toBe(200);
    expect((await call(receipt)).status).toBe(404);
    expect(remoteCall).toHaveBeenCalledOnce();
    expect(remoteCall.mock.calls[0]?.[0]?.arguments).toEqual(args);
    control.close();
    registry.close();
  });
});
