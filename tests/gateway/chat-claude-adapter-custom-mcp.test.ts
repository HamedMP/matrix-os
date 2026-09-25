import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";

const serverId = "123e4567-e89b-42d3-a456-426614174000";
const approvalId = "123e4567-e89b-42d3-a456-426614174001";
const nativeInput = { server_id: serverId, tool: "read", arguments: { path: "/public/fixture" } };
const input = {
  owner: { type: "personal" as const, ownerId: "owner_claude" },
  chatId: "chat_1", turnId: "cturn_1", runId: "run_1",
  prompt: "Read public fixture", parts: [{ type: "text" as const, text: "Read public fixture" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
  interactionMode: "default", permissionMode: "supervised", executionRoot: "/safe/project",
  signal: new AbortController().signal,
};

describe("canonical Claude native Custom MCP approval handoff", () => {
  it("continues a supervised Run when approval lease registration fails, leaving always_ask to broker policy", async () => {
    const responses: Array<{ behavior: string; updatedInput?: Record<string, unknown> }> = [];
    const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { write(chunk: string, callback?: (error?: Error | null) => void): boolean; end(): void };
        stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.stdin = {
        write(chunk, callback) {
          callback?.();
          const frame = JSON.parse(chunk) as { type: string; response?: { response: { behavior: string; updatedInput?: Record<string, unknown> } } };
          if (frame.type === "user") queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "control_request", request_id: "native_1", request: { subtype: "can_use_tool",
              tool_name: "mcp__matrix-integrations__call_custom_mcp_tool",
              input: { ...nativeInput, approval_receipt: "forged-by-model" } },
          })}\n`)));
          if (frame.type === "control_response" && frame.response) {
            responses.push(frame.response.response);
            queueMicrotask(() => {
              child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success",
                is_error: false, result: "done", session_id: "claude_fixture_session" })}\n`));
              child.emit("exit", 0, null);
            });
          }
          return true;
        },
        end() {},
      };
      return child;
    });
    const approvalClient = {
      registerRun: vi.fn(async () => false), prepare: vi.fn(), decide: vi.fn(), revokeRun: vi.fn(),
    } as unknown as CustomMcpApprovalClient;
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn,
      resolveCredentialEnv: async () => ({}), customMcpApprovalClient: approvalClient,
      matrixMcpCapabilityIssuer: createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner_claude" }),
    });
    const events: string[] = [];
    for await (const event of adapter.start(input)) events.push(event.type);
    expect(events).toContain("run.completed");
    expect(events).not.toContain("approval.requested");
    expect(approvalClient.prepare).not.toHaveBeenCalled();
    expect(responses).toEqual([{ behavior: "allow", updatedInput: nativeInput }]);
  });

  it("keeps the CLI callback pending until a Platform-proven canonical decision supplies one receipt", async () => {
    const responses: Array<{ response: { response: { behavior: string; updatedInput?: Record<string, unknown> } } }> = [];
    const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { write(chunk: string, callback?: (error?: Error | null) => void): boolean; end(): void };
        stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.stdin = {
        write(chunk, callback) {
          callback?.();
          const frame = JSON.parse(chunk) as { type: string; response?: typeof responses[number]["response"] };
          if (frame.type === "user") queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "control_request", request_id: "native_1", request: { subtype: "can_use_tool",
              tool_name: "mcp__matrix-integrations__call_custom_mcp_tool", input: nativeInput },
          })}\n`)));
          if (frame.type === "control_response" && frame.response) {
            responses.push({ response: frame.response });
            queueMicrotask(() => {
              child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success",
                is_error: false, result: "done", session_id: "claude_fixture_session" })}\n`));
              child.emit("exit", 0, null);
            });
          }
          return true;
        },
        end() {},
      };
      return child;
    });
    const approvalClient = {
      registerRun: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ kind: "pending" as const, approvalId,
        expiresAt: new Date(Date.now() + 60_000).toISOString() })),
      decide: vi.fn(async () => ({ receipt: "a".repeat(64) })),
      revokeRun: vi.fn(async () => true),
    } as unknown as CustomMcpApprovalClient;
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn,
      resolveCredentialEnv: async () => ({}), customMcpApprovalClient: approvalClient,
      matrixMcpCapabilityIssuer: createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner_claude" }),
    });
    const events: string[] = [];
    for await (const event of adapter.start(input)) {
      events.push(event.type);
      if (event.type === "approval.requested") {
        expect(responses).toEqual([]);
        expect(event.approvalId).toBe(approvalId);
        await adapter.submitApproval!({ owner: input.owner, chatId: input.chatId, runId: input.runId,
          approvalId, decision: "approve", clientRequestId: "req_1", platformApprovalProof: "signed-platform-proof" });
      }
    }
    expect(events).toContain("approval.requested");
    expect(events).toContain("approval.resolved");
    expect(events).toContain("run.completed");
    expect(approvalClient.decide).toHaveBeenCalledWith("run_1", approvalId, "approve", {
      chatId: "chat_1", clientRequestId: "req_1", platformApprovalProof: "signed-platform-proof",
    });
    expect(responses).toMatchObject([{ response: { response: { behavior: "allow",
      updatedInput: { ...nativeInput, approval_receipt: "a".repeat(64) } } } }]);
    expect(approvalClient.revokeRun).toHaveBeenCalledWith("run_1");
  });
});
