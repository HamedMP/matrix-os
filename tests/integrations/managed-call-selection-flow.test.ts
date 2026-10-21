import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createClaudeIntegrationApprovalControl } from "../../packages/gateway/src/chat/claude-integration-approval.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";
import { proxyIntegrationRequest } from "../../packages/gateway/src/integrations/platform-proxy.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/dist/server.js";
import { createManagedOAuthPresetBroker } from "../../packages/platform/src/managed-oauth-preset-broker.js";
import { createManagedPresetRouter } from "../../packages/platform/src/managed-preset-router.js";

describe("managed account selection through native approval and MCP transport", () => {
  it.each([
    { name: "matching account executes once", label: "Loops", replaced: false, status: 200 },
    { name: "unknown approved label never executes", label: "Missing", replaced: false, status: 403 },
    { name: "replacement after inventory never executes", label: "Loops", replaced: true, status: 502 },
  ])("$name", async ({ label, replaced, status }) => {
    const ownerId = "owner_managed_flow";
    const action = { service: "loops", action: "list_teams", label, params: {} };
    let reads = 0;
    const providerCall = vi.fn(async () => ({ teams: [] }));
    const broker = createManagedOAuthPresetBroker({
      broker: {
        getPreset: vi.fn(async (userId, presetId) => {
          expect(userId).toBe(ownerId);
          if (presetId !== "loops") return null;
          reads += 1;
          return { id: replaced && reads > 1 ? "replacement" : "approved_account", status: "ready",
            created_at: "2026-10-10", tools: [{ name: "teams", inputSchema: { type: "object", properties: {} } }] };
        }),
        ensurePreset: vi.fn(), activatePreset: vi.fn(), remove: vi.fn(), callManagedPresetTool: providerCall,
      },
      oauth: { start: vi.fn() },
    });
    const platform = new Hono();
    platform.route("/internal/integrations", createIntegrationRoutes({ db: {} as PlatformDb,
      pipedream: { getAppInfo: vi.fn(async () => null) } as unknown as PipedreamConnectClient,
      webhookSecret: "fixture-only", resolveUserId: async () => ownerId,
      mcpPresetBroker: createManagedPresetRouter({ loops: broker }) }));
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: ownerId });
    const capability = registry.issue({ owner: { type: "personal", ownerId }, runId: "run_managed", scope: "chat_call" })!;
    const events: CanonicalProviderRunEvent[] = [];
    const respond = vi.fn(async (value: unknown) => { void value; });
    const control = createClaudeIntegrationApprovalControl({ runId: "run_managed", homePath: "/safe/home", capability,
      verify: vi.fn(async () => true), emit: event => events.push(event), onError: error => { throw error; } });
    const forward = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/internal/integrations/call");
      expect(new Headers(init?.headers).has("x-matrix-integration-approval")).toBe(false);
      expect(JSON.parse(await (init!.body as Blob).text())).toEqual(action);
      return platform.request(String(url), init);
    });
    const gateway = new Hono();
    gateway.use("*", authMiddleware("fixture-host", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    gateway.all("*", c => proxyIntegrationRequest(c, { targetBase: "https://platform.invalid/internal/integrations",
      machineToken: "fixture-platform", fetcher: forward }));
    const responses: number[] = [];
    const server = createIntegrationsMcpServer({ toolSurface: "chat-call", fetcher: async (url, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${capability.token}`);
      const response = await gateway.request(url, { ...init, headers });
      responses.push(response.status);
      return response;
    } });
    const client = new Client({ name: "managed-selection-test", version: "1.0.0" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(right), client.connect(left)]);
      control.onToolPermission({ nativeRequestId: "native_managed", toolName: "mcp__matrix-integrations__call_service",
        input: action }, respond);
      const approval = events[0] as Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>;
      expect(providerCall).not.toHaveBeenCalled();
      await control.submit(approval.approvalId, "approve", { chatId: "chat_managed", clientRequestId: "request_managed",
        platformApprovalProof: "fixture-signed-decision" });
      const { updatedInput } = respond.mock.calls[0]![0] as { updatedInput: typeof action & { matrix_approval_receipt: string } };
      expect(updatedInput).toEqual({ ...action, matrix_approval_receipt: expect.stringMatching(/^[a-f0-9]{64}$/) });
      await client.callTool({ name: "call_service", arguments: updatedInput });
      expect(responses).toEqual([status]);
      if (status === 200) expect(providerCall).toHaveBeenCalledExactlyOnceWith({ userId: ownerId,
        serverId: "approved_account", presetId: "loops", toolName: "teams", arguments: {} });
      else expect(providerCall).not.toHaveBeenCalled();
      await client.callTool({ name: "call_service", arguments: updatedInput });
      expect(responses).toEqual([status, 403]);
      expect(forward).toHaveBeenCalledOnce();
    } finally { control.close(); registry.close(); await client.close(); await server.close(); }
  });
});
