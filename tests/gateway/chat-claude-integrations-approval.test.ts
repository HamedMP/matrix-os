import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";

const action = { service: "google_drive", action: "list_files", label: "work", params: { max_results: 3 } };
const input = { owner: { type: "personal" as const, ownerId: "owner_claude" },
  chatId: "chat_1", turnId: "cturn_1", runId: "run_1", prompt: "List three Drive files",
  parts: [{ type: "text" as const, text: "List three Drive files" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
  interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };

describe("Claude Chat built-in action approval", () => {
  it.each([
    { permissionMode: "supervised", resumed: false }, { permissionMode: "auto_accept_edits", resumed: false },
    { permissionMode: "auto", resumed: false }, { permissionMode: "supervised", resumed: true },
    { permissionMode: "supervised", resumed: false, tool: "connect_service", action: { service: "google_drive", label: "work" }, method: "POST", path: "/api/integrations/connect" },
    { permissionMode: "supervised", resumed: false, tool: "sync_services", action: {}, method: "POST", path: "/api/integrations/sync" },
    { permissionMode: "supervised", resumed: false, tool: "disconnect_service", action: { connection_id: "00000000-0000-4000-8000-000000000001" }, method: "DELETE", path: "/api/integrations/00000000-0000-4000-8000-000000000001" },
  ])("pauses $permissionMode (resumed=$resumed, tool=$tool) until the authenticated decision grants the exact request", async testCase => {
    const { permissionMode, resumed } = testCase;
    const tool = "tool" in testCase ? testCase.tool : "call_service";
    const requestedAction = "action" in testCase ? testCase.action : action;
    const method = "method" in testCase ? testCase.method : "POST";
    const path = "path" in testCase ? testCase.path : "/api/integrations/call";
    const body = tool === "disconnect_service" ? {} : requestedAction;
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: input.owner.ownerId });
    const responses: unknown[] = [];
    const providerCalls: unknown[] = [];
    const spawnFn = vi.fn<CanonicalCliSpawn>((_command, _args, options) => {
      const child = new EventEmitter() as ReturnType<CanonicalCliSpawn>;
      child.stdout = new EventEmitter() as typeof child.stdout;
      child.stderr = new EventEmitter() as typeof child.stderr;
      child.kill = vi.fn();
      child.stdin = { write(chunk: string, callback?: (error?: Error | null) => void) {
        callback?.();
        const frame = JSON.parse(chunk);
        if (frame.type === "user") queueMicrotask(() => child.stdout!.emit("data", Buffer.from(`${JSON.stringify({
          type: "control_request", request_id: "native_drive", request: { subtype: "can_use_tool",
            tool_name: `mcp__matrix-integrations__${tool}`, input: requestedAction },
        })}\n`)));
        if (frame.type === "control_response") {
          responses.push(frame.response.response);
          if (frame.response.response.behavior === "allow") {
            const context = registry.resolveRunContext(options.env.MATRIX_AGENT_INTEGRATIONS_TOKEN!, method, path);
            const receipt = frame.response.response.updatedInput.matrix_approval_receipt;
            expect(receipt).toMatch(/^[a-f0-9]{64}$/);
            expect(context?.consumeIntegrationRequest?.(method, path, body, receipt)).toBe(true);
            expect(context?.consumeIntegrationRequest?.(method, path, body, receipt)).toBe(false);
            providerCalls.push(requestedAction);
          }
          queueMicrotask(() => {
            child.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`));
            child.emit("exit", 0, null);
          });
        }
        return true;
      }, end() {} } as typeof child.stdin;
      return child;
    });
    const verifyIntegrationDecision = vi.fn(async () => true);
    const client = { registerRun: vi.fn(async () => ({ generation: 1 })), revokeRun: vi.fn(async () => true),
      verifyIntegrationDecision } as unknown as CustomMcpApprovalClient;
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn,
      matrixMcpCapabilityIssuer: registry, customMcpApprovalClient: client, resolveCredentialEnv: async () => ({}) });
    const events: string[] = [];
    const run = { ...input, permissionMode };
    for await (const event of resumed ? adapter.resume!({ ...run, resumeState: { sessionId: "claude_fixture" } }) : adapter.start(run)) {
      events.push(event.type);
      if (event.type === "approval.requested") {
        expect(responses).toEqual([]);
        expect(providerCalls).toEqual([]);
        await expect(adapter.submitApproval!({ owner: { type: "personal", ownerId: "wrong_owner" }, chatId: input.chatId, runId: input.runId,
          approvalId: event.approvalId, decision: "approve", clientRequestId: "wrong_req", platformApprovalProof: "forged" })).rejects.toThrow();
        await adapter.submitApproval!({ owner: input.owner, chatId: input.chatId, runId: input.runId,
          approvalId: event.approvalId, decision: "approve", clientRequestId: "req_1", platformApprovalProof: "signed-human-decision" });
      }
    }
    expect(events).toContain("approval.requested");
    expect(events).toContain("approval.resolved");
    expect(verifyIntegrationDecision).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_1", runId: "run_1",
      clientRequestId: "req_1", decision: "approve", platformApprovalProof: "signed-human-decision" }));
    expect(responses).toEqual([{ behavior: "allow", updatedInput: { ...requestedAction,
      matrix_approval_receipt: expect.stringMatching(/^[a-f0-9]{64}$/) } }]);
    expect(providerCalls).toEqual([requestedAction]);
    const args = spawnFn.mock.calls[0]![1];
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.permissions.ask).toContain(`mcp__matrix-integrations__${tool}`);
    registry.close();
  });
});
