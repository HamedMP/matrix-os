import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";

const input = { owner: { type: "personal" as const, ownerId: "owner_claude" }, chatId: "chat_1", turnId: "cturn_1", runId: "run_1",
  prompt: "Help", parts: [{ type: "text" as const, text: "Help" }], selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
  interactionMode: "default", permissionMode: "supervised" };
const question = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Blue", description: "Ocean" }, { label: "Red", description: "Fire" }] }] };
afterEach(() => vi.useRealTimers());

async function start(fundedRunTimeoutMs?: number) {
  const signal = new AbortController();
  const stdout = new EventEmitter();
  const writes: unknown[] = [];
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new EventEmitter(),
    stdin: { write: (frame: string, callback?: (error?: Error | null) => void) => { writes.push(JSON.parse(frame)); callback?.(); return true; } },
    kill: vi.fn((killSignal: NodeJS.Signals) => { queueMicrotask(() => child.emit("exit", null, killSignal)); }),
  });
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: input.owner.ownerId });
  const client = { registerRun: vi.fn(async () => ({ generation: 1 })), revokeRun: vi.fn(async () => true),
    verifyIntegrationDecision: vi.fn(async () => true), prepare: vi.fn(async () => ({ kind: "pending", approvalId: "mcp_approval",
      expiresAt: new Date(Date.now() + 60_000).toISOString() })), decide: vi.fn(async () => ({ receipt: "approved" })),
  } as unknown as CustomMcpApprovalClient;
  const adapter = createClaudeChatProviderAdapter({ homePath: "/safe/home", spawnFn: () => child, timeoutMs: 30,
    resolveCredentialLaunch: async () => ({ env: {}, ...(fundedRunTimeoutMs ? { fundedRunTimeoutMs } : {}) }),
    matrixMcpCapabilityIssuer: registry, customMcpApprovalClient: client,
  });
  const events: CanonicalProviderRunEvent[] = [];
  const result = (async () => { for await (const event of adapter.start({ ...input, signal: signal.signal })) events.push(event); })();
  await vi.advanceTimersByTimeAsync(0);
  const request = (requestId: string, toolName = "AskUserQuestion", toolInput: Record<string, unknown> = question) => {
    stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "control_request", request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: toolName, input: toolInput } })}\n`));
  };
  const close = async () => { signal.abort(); await result; registry.close(); };
  return { adapter, signal, child, events, writes, result, request, close, stdout };
}

it("waits for every pending question, then restarts a fresh idle interval after the last answer", async () => {
  vi.useFakeTimers();
  const run = await start();
  try {
    run.request("first"); run.request("second");
    await vi.advanceTimersByTimeAsync(100);
    expect(run.child.kill).not.toHaveBeenCalled();
    await run.adapter.submitInput!({ ...input, requestId: "first", clientRequestId: "answer_first", structuredAnswers: { q0: ["Blue"] } });
    await vi.advanceTimersByTimeAsync(100);
    expect(run.child.kill).not.toHaveBeenCalled();
    await run.adapter.submitInput!({ ...input, requestId: "second", clientRequestId: "answer_second", structuredAnswers: { q0: ["Red"] } });
    await vi.advanceTimersByTimeAsync(29);
    expect(run.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run.result;
    expect(run.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  } finally { await run.close(); }
});

it.each([
  { name: "built-in", tool: "Bash", toolInput: { command: "pwd" } },
  { name: "integration", tool: "mcp__matrix-integrations__call_service", toolInput: { service: "google_drive", action: "list_files", label: "work", params: { max_results: 3 } } },
  { name: "custom MCP", tool: "mcp__matrix-integrations__call_custom_mcp_tool", toolInput: { server_id: "123e4567-e89b-42d3-a456-426614174000", tool: "read", arguments: {} } },
])("suspends idle while $name approval is pending and resumes after its decision", async ({ tool, toolInput }) => {
  vi.useFakeTimers();
  const run = await start();
  try {
    run.request("native_approval", tool, toolInput);
    await vi.advanceTimersByTimeAsync(100);
    const event = run.events.find(event => event.type === "approval.requested");
    expect(event?.type).toBe("approval.requested");
    expect(run.child.kill).not.toHaveBeenCalled();
    if (event?.type !== "approval.requested") throw new Error("Expected approval");
    await run.adapter.submitApproval!({ ...input, approvalId: event.approvalId, decision: "decline", clientRequestId: "decision", platformApprovalProof: "signed" });
    await vi.advanceTimersByTimeAsync(29);
    expect(run.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run.result;
    expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  } finally { await run.close(); }
});

it("retains the funded absolute deadline while a human question is pending", async () => {
  vi.useFakeTimers();
  const run = await start(100);
  try {
    run.request("question");
    await vi.advanceTimersByTimeAsync(99);
    expect(run.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run.result;
    expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    const writes = run.writes.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await expect(run.adapter.submitInput!({ ...input, requestId: "question", clientRequestId: "late", structuredAnswers: { q0: ["Blue"] } })).rejects.toThrow();
    expect(run.writes).toHaveLength(writes);
  } finally { await run.close(); }
});

it("denies an expired question then resumes idle without allowing a late answer", async () => {
  vi.useFakeTimers();
  const run = await start();
  try {
    run.request("question");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(run.events).toContainEqual({ type: "input.resolved", requestId: "question", reason: "expired" });
    expect(run.child.kill).not.toHaveBeenCalled();
    expect(run.writes.at(-1)).toMatchObject({ type: "control_response", response: { response: { behavior: "deny" } } });
    await expect(run.adapter.submitInput!({ ...input, requestId: "question", clientRequestId: "late", structuredAnswers: { q0: ["Blue"] } })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30);
    await run.result;
    expect(vi.getTimerCount()).toBe(0);
  } finally { await run.close(); }
});
