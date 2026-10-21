import { expect, it, vi } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
const serverId = "123e4567-e89b-42d3-a456-426614174000";
const approvalId = "123e4567-e89b-42d3-a456-426614174001";
const binding = { kind: "managed_chat", ownerId: "owner_qa", chatId: "chat_qa", runId: "run_qa", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", capabilities: ["mcp.inventory", "mcp.describe", "mcp.call"] } as ManagedPiRuntimeBinding;
function setup(pending = false) {
  const events: Array<Record<string, unknown>> = []; const abort = new AbortController();
  const prepare = vi.fn(async () => pending ? { kind: "pending" as const, approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() } : { kind: "allow" as const });
  const decide = vi.fn(async () => ({ receipt: "a".repeat(64) }));
  const revokeRun = vi.fn(async () => true);
  const registerRun = vi.fn(async () => ({ generation: 3 }));
  const call = vi.fn(async () => ({ content: [{ type: "text", text: "QA" }] }));
  const tools = createManagedPiOwnerTools({ authority: async () => ({ permissionMode: "full_access" }), signalFor: () => abort.signal,
    mcp: { inventory: async () => [], describe: async () => ({ id: serverId }), call },
    approvals: { registerRun, prepare, decide, revokeRun, clearRunApprovals: async () => ({ generation: 4, invalidated: 1 }) } });
  void tools.open(binding, event => events.push(event));
  const request = BotToolRequestSchema.parse({ toolCallId: "call_mcp", capability: "mcp.call", args: { serverId, tool: "qa_echo", arguments: { text: "QA" } } });
  return { tools, request, call, prepare, decide, revokeRun, registerRun, events, abort };
}
it("shares one pending registration across distinct concurrent first MCP calls", async () => {
  const { tools, request, registerRun, prepare, revokeRun } = setup();
  let finish!: (value: { generation: number }) => void;
  const registered = new Promise<{ generation: number }>(resolve => { finish = resolve; });
  registerRun.mockImplementation(() => registered);
  const first = tools.prepare(binding, request, new AbortController().signal);
  const second = tools.prepare(binding, { ...request, toolCallId: "call_mcp_second" }, new AbortController().signal);
  await vi.waitFor(() => expect(registerRun).toHaveBeenCalled());
  finish({ generation: 3 });
  await Promise.all([first, second]);
  expect(registerRun).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(2);
  await tools.closeRun(binding.runId);
  expect(revokeRun).toHaveBeenCalledTimes(1);
});
it("waits for and revokes a late registration after close without preparing a tool", async () => {
  const { tools, request, registerRun, prepare, revokeRun, call } = setup();
  let finish!: (value: { generation: number }) => void;
  registerRun.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const work = tools.prepare(binding, request, new AbortController().signal);
  const refused = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(registerRun).toHaveBeenCalledTimes(1));
  let closed = false;
  const closing = tools.closeRun(binding.runId).then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish({ generation: 3 });
  await Promise.all([closing, refused]);
  expect(revokeRun).toHaveBeenCalledExactlyOnceWith(binding.runId);
  expect(prepare).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});
it("uses exact Platform policy/generation; allow never fabricates an approval receipt", async () => {
  const { tools, request, prepare, call, revokeRun } = setup();
  await tools.prepare(binding, request, new AbortController().signal);
  expect(call).not.toHaveBeenCalled();
  await tools.dispatch(binding, request, new AbortController().signal);
  expect(prepare).toHaveBeenCalledWith("run_qa", { generation: 3, nativeRequestId: "call_mcp", serverId, tool: "qa_echo", arguments: { text: "QA" } });
  expect(call).toHaveBeenCalledWith("owner_qa", { serverId, tool: "qa_echo", arguments: { text: "QA" }, runId: "run_qa" }, expect.any(AbortSignal));
  await tools.closeRun("run_qa"); expect(revokeRun).toHaveBeenCalledExactlyOnceWith("run_qa");
});
it("waits for signed human proof and forwards the one-use exact-tool receipt", async () => {
  const { tools, request, call, events, decide } = setup(true);
  const work = tools.dispatch(binding, request, new AbortController().signal);
  await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
  expect(call).not.toHaveBeenCalled();
  await tools.submit({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId, runId: binding.runId,
    approvalId, decision: "approve", clientRequestId: "req_qa", platformApprovalProof: "signed-proof" });
  await work;
  expect(decide).toHaveBeenCalledWith("run_qa", approvalId, "approve", { chatId: binding.chatId, clientRequestId: "req_qa", platformApprovalProof: "signed-proof" });
  expect(call.mock.calls[0]?.[1]).toMatchObject({ approvalReceipt: "a".repeat(64) });
  await tools.closeRun("run_qa");
});
it("forged approval and Stop never reach the remote MCP tool", async () => {
  for (const cancel of [false, true]) {
    const { tools, request, call, events, abort } = setup(true);
    const work = tools.dispatch(binding, request, new AbortController().signal);
    const rejected = expect(work).rejects.toThrow();
    await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
    if (cancel) abort.abort();
    else await expect(tools.submit({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId, runId: binding.runId, approvalId, decision: "approve", clientRequestId: "req_qa" })).rejects.toThrow();
    await rejected; expect(call).not.toHaveBeenCalled(); await tools.closeRun("run_qa");
  }
});
