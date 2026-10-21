import { expect, it, vi } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { getService } from "../../../packages/gateway/src/integrations/registry.js";
const binding = { kind: "managed_chat", ownerId: "owner_qa", chatId: "chat_qa", runId: "run_qa", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", capabilities: ["integration.inventory", "integration.describe", "integration.call"], workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64) } as ManagedPiRuntimeBinding;
function setup(permissionMode = "full_access") {
  const call = vi.fn(async () => ({ data: { count: 0 } }));
  const inventory = vi.fn(async () => [{ connectionId: "conn_qa", service: "github", label: "QA" }]);
  const authority = vi.fn(async () => ({ permissionMode }));
  const describe = vi.fn(async (_owner: string, input: { service: string; readOnly: boolean }) => Object.entries(getService(input.service)!.actions)
    .filter(([, action]) => !input.readOnly || action.risk === "read")
    .map(([id, action]) => ({ id, description: action.description, risk: action.risk, params: action.params })));
  const signal = new AbortController(); const events: Array<Record<string, unknown>> = [];
  const tools = createManagedPiOwnerTools({ authority, signalFor: () => signal.signal, integrations: { inventory, call, describe } });
  tools.open(binding, event => events.push(event));
  return { tools, call, inventory, authority, signal, events, describe };
}
let serial = 0;
const request = (action: string, params: Record<string, unknown>) => BotToolRequestSchema.parse({ capability: "integration.call", toolCallId: `call_${++serial}`, args: { service: "github", connectionId: "conn_qa", action, params } });
it("declares only actually wired capabilities and validates bounded MCP/describe args", () => {
  expect(createManagedPiOwnerTools({ authority: async () => ({ permissionMode: "full_access" }), signalFor: () => null }).capabilities).toEqual([]);
  expect(BotToolRequestSchema.safeParse({ capability: "mcp.call", toolCallId: "call_qa", args: { serverId: "no", tool: "test", arguments: {}, approvalGranted: true } }).success).toBe(false);
  expect(BotToolRequestSchema.safeParse({ capability: "integration.describe", toolCallId: `call_${++serial}`, args: { service: "github" } }).success).toBe(true);
});
it("uses exact owner/account and read-only transport; exposes actual registry schema", async () => {
  const { tools, call } = setup("supervised");
  await tools.dispatch(binding, request("list_issues", { repo: "matrix/qa", per_page: 1 }), new AbortController().signal);
  expect(call).toHaveBeenCalledWith("owner_qa", { service: "github", action: "list_issues", label: "QA", params: { repo: "matrix/qa", per_page: 1 }, read: true }, expect.any(AbortSignal));
  const result = await tools.dispatch(binding, BotToolRequestSchema.parse({ toolCallId: "describe_qa", capability: "integration.describe", args: { service: "github" } }), new AbortController().signal);
  expect(JSON.stringify(result)).toContain("list_issues"); expect(JSON.stringify(result)).not.toContain("create_issue");
});
it("does not infer action or parameter availability from the static registry", async () => {
  const { tools, call, inventory, describe } = setup();
  describe.mockResolvedValueOnce([]);
  await expect(tools.dispatch(binding, request("list_issues", { repo: "matrix/qa" }), new AbortController().signal)).rejects.toThrow();
  describe.mockResolvedValueOnce([{ id: "list_issues", description: "List", risk: "read", params: { repo: { type: "string", required: true } } }]);
  await expect(tools.dispatch(binding, request("list_issues", { repo: "matrix/qa", per_page: 1 }), new AbortController().signal)).rejects.toThrow();
  expect(inventory).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});
it("rechecks authoritative action availability after human approval", async () => {
  const { tools, call, events, describe } = setup();
  const work = tools.dispatch(binding, request("create_issue", { repo: "matrix/qa", title: "QA" }), new AbortController().signal);
  const refused = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
  describe.mockResolvedValue([]);
  await tools.submit({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId, runId: binding.runId,
    approvalId: events[0]!.approvalId as string, decision: "approve", clientRequestId: "req_policy_change" });
  await refused; expect(call).not.toHaveBeenCalled();
});
it("waits for exact authenticated canonical approval before a mutation, consumes it once", async () => {
  const { tools, call, events } = setup();
  const work = tools.dispatch(binding, request("create_issue", { repo: "matrix/qa", title: "QA" }), new AbortController().signal);
  await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
  expect(call).not.toHaveBeenCalled();
  const approvalId = events[0]!.approvalId as string;
  await expect(tools.submit({ owner: { type: "personal", ownerId: "other" }, chatId: binding.chatId, runId: binding.runId, approvalId, decision: "approve", clientRequestId: "req_qa" })).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
  await tools.submit({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId, runId: binding.runId, approvalId, decision: "approve", clientRequestId: "req_qa" });
  await work; expect(call).toHaveBeenCalledTimes(1);
  await expect(tools.submit({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId, runId: binding.runId, approvalId, decision: "approve", clientRequestId: "req_again" })).rejects.toThrow();
});
it("fails closed for supervised mutation, stale generation, missing/ambiguous account and invalid params", async () => {
  const { tools, call, inventory } = setup("supervised");
  await expect(tools.dispatch(binding, request("create_issue", { repo: "matrix/qa", title: "QA" }), new AbortController().signal)).rejects.toThrow();
  await expect(tools.dispatch({ ...binding, executionGeneration: "2" }, request("list_issues", { repo: "matrix/qa" }), new AbortController().signal)).rejects.toThrow();
  await expect(tools.dispatch(binding, request("list_issues", {}), new AbortController().signal)).rejects.toThrow();
  inventory.mockResolvedValueOnce([]);
  await expect(tools.dispatch(binding, request("list_issues", { repo: "matrix/qa" }), new AbortController().signal)).rejects.toThrow();
  inventory.mockResolvedValueOnce([{ connectionId: "conn_qa", service: "github", label: "QA" }, { connectionId: "conn_other", service: "github", label: "QA" }]);
  await expect(tools.dispatch(binding, request("list_issues", { repo: "matrix/qa" }), new AbortController().signal)).rejects.toThrow();
  expect(inventory).toHaveBeenCalledTimes(2);
  expect(call).not.toHaveBeenCalled();
});
it("cancellation revokes pending approval and never dispatches a write", async () => {
  const { tools, call, events, signal } = setup();
  const work = tools.dispatch(binding, request("create_issue", { repo: "matrix/qa", title: "QA" }), new AbortController().signal);
  const rejected = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
  signal.abort(); await rejected; tools.closeRun(binding.runId);
  expect(call).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({ type: "approval.resolved", decision: "cancel" });
});
it("rechecks authority and connected account after approval and refuses changed identity", async () => {
  const { tools, call, events, inventory } = setup();
  const work = tools.dispatch(binding, request("create_issue", { repo: "matrix/qa", title: "QA" }), new AbortController().signal);
  const rejected = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
  inventory.mockResolvedValue([{ connectionId: "conn_qa", service: "github", label: "Replacement" }]);
  await tools.submit({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId, runId: binding.runId, approvalId: events[0]!.approvalId as string, decision: "approve", clientRequestId: "req_qa" });
  await rejected; expect(call).not.toHaveBeenCalled();
});
it("denies unavailable transports and recipe identities without inheriting owner authority", async () => {
  const { tools, call } = setup();
  await expect(tools.dispatch({ ...binding, ownerId: "wrong" }, request("list_issues", { repo: "matrix/qa" }), new AbortController().signal)).rejects.toThrow();
  await expect(tools.dispatch({ ...binding, runId: "run_other" }, request("list_issues", { repo: "matrix/qa" }), new AbortController().signal)).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});
