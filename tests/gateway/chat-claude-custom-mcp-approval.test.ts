import { describe, expect, it, vi } from "vitest";
import { createClaudeCustomMcpApprovalControl } from "../../packages/gateway/src/chat/claude-custom-mcp-approval.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";

const serverId = "123e4567-e89b-42d3-a456-426614174000";
const approvalId = "123e4567-e89b-42d3-a456-426614174001";
const toolName = "mcp__matrix-integrations__call_custom_mcp_tool";
const args = { path: "/public/fixture" };
const input = { server_id: serverId, tool: "read", arguments: args };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(prepareKind: "pending" | "allow" = "pending") {
  const events: Array<{ type: string; approvalId?: string; safeDescription?: string; decision?: string }> = [];
  const writes: unknown[] = [];
  const prepare = vi.fn(async () => prepareKind === "allow" as const
    ? { kind: "allow" as const }
    : { kind: "pending" as const, approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const decide = vi.fn(async (_runId: string, _id: string, decision: string) => decision === "approve"
    ? { receipt: "a".repeat(64) } : {});
  const client = { prepare, decide } as unknown as CustomMcpApprovalClient;
  const control = createClaudeCustomMcpApprovalControl({
    runId: "run_owner", client, emit: event => events.push(event),
    onError: error => { throw error; },
  });
  const respond = vi.fn(async (value: unknown) => { writes.push(value); });
  return { control, client, events, writes, prepare, decide, respond };
}

describe("supervised Claude Custom MCP permission callback", () => {
  it("binds a pending approval to exact native input and returns only the server receipt", async () => {
    const state = fixture();
    expect(state.control.onToolPermission({ nativeRequestId: "native_1", toolName, input }, state.respond)).toBe(true);
    await flush();
    expect(state.prepare).toHaveBeenCalledWith("run_owner", {
      nativeRequestId: "native_1", serverId, tool: "read", arguments: args,
    });
    expect(state.events[0]).toMatchObject({ type: "approval.requested", approvalId,
      safeDescription: expect.stringContaining('"path":"/public/fixture"') });
    expect(state.writes).toEqual([]);
    await state.control.submit(approvalId, "approve", { chatId: "chat_owner", clientRequestId: "req_1", platformApprovalProof: "signed-fixture" });
    expect(state.decide).toHaveBeenCalledWith("run_owner", approvalId, "approve", {
      chatId: "chat_owner", clientRequestId: "req_1", platformApprovalProof: "signed-fixture",
    });
    expect(state.writes).toEqual([{ behavior: "allow", updatedInput: {
      ...input, approval_receipt: "a".repeat(64),
    } }]);
    expect(state.events[1]).toMatchObject({ type: "approval.resolved", approvalId, decision: "approve" });
    await expect(state.control.submit(approvalId, "approve")).rejects.toThrow();
    state.control.close();
  });

  it("declines without a tool call, cancels a native request and refuses session approvals", async () => {
    const state = fixture();
    state.control.onToolPermission({ nativeRequestId: "native_1", toolName, input }, state.respond);
    await flush();
    await expect(state.control.submit(approvalId, "approve_for_session")).rejects.toThrow();
    await state.control.submit(approvalId, "decline", { chatId: "chat_owner", clientRequestId: "req_1", platformApprovalProof: "signed-fixture" });
    expect(state.writes).toEqual([{ behavior: "deny", message: "Custom MCP approval is unavailable." }]);
    state.control.onToolPermission({ nativeRequestId: "native_2", toolName, input }, state.respond);
    await flush();
    state.control.onToolPermissionCancel("native_2");
    await flush();
    expect(state.decide).toHaveBeenCalledWith("run_owner", approvalId, "cancel");
    expect(state.writes).toHaveLength(2);
    state.control.close();
  });

  it("takes the current allow fast path, rejects altered or overlong inputs and drains on close", async () => {
    const allowed = fixture("allow");
    allowed.control.onToolPermission({ nativeRequestId: "native_allow", toolName, input }, allowed.respond);
    await flush();
    expect(allowed.writes).toEqual([{ behavior: "allow", updatedInput: input }]);
    expect(allowed.events).toEqual([]);
    expect(allowed.decide).not.toHaveBeenCalled();
    allowed.control.close();

    const pending = fixture();
    expect(pending.control.onToolPermission({ nativeRequestId: "native_other", toolName: "Bash", input }, pending.respond)).toBe(false);
    pending.control.onToolPermission({ nativeRequestId: "native_bad", toolName, input: { ...input, approval_receipt: "forged" } }, pending.respond);
    pending.control.onToolPermission({ nativeRequestId: "native_long", toolName,
      input: { ...input, arguments: { content: "x".repeat(5_000) } } }, pending.respond);
    await flush();
    expect(pending.prepare).not.toHaveBeenCalled();
    pending.control.onToolPermission({ nativeRequestId: "native_valid", toolName, input }, pending.respond);
    await flush();
    pending.control.close();
    await expect(pending.control.submit(approvalId, "approve")).rejects.toThrow();
    expect(pending.writes).toHaveLength(3);
  });

  it("bounds concurrent prepares and cancels a native request before Platform replies", async () => {
    const releases: Array<(value: { kind: "pending"; approvalId: string; expiresAt: string }) => void> = [];
    const events: Array<{ type: string }> = [];
    const writes: unknown[] = [];
    const decide = vi.fn(async () => ({}));
    const client = { prepare: vi.fn(() => new Promise(resolve => { releases.push(resolve); })), decide } as unknown as CustomMcpApprovalClient;
    const control = createClaudeCustomMcpApprovalControl({
      runId: "run_owner", client, emit: event => events.push(event),
      onError: error => { throw error; },
    });
    const respond = async (value: unknown) => { writes.push(value); };
    for (let index = 0; index < 17; index++) {
      control.onToolPermission({ nativeRequestId: `native_${index}`, toolName, input }, respond);
    }
    expect(client.prepare).toHaveBeenCalledTimes(16);
    expect(writes).toHaveLength(1);
    control.onToolPermissionCancel("native_0");
    releases[0]!({ kind: "pending", approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await flush();
    expect(decide).toHaveBeenCalledWith("run_owner", approvalId, "cancel");
    expect(events).not.toContainEqual(expect.objectContaining({ type: "approval.requested" }));
    control.close();
    for (let index = 1; index < releases.length; index++) releases[index]!({
      kind: "pending", approvalId: "123e4567-e89b-42d3-a456-426614174002",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
  });

  it("releases preparing capacity after malformed and oversized native callbacks", async () => {
    const state = fixture("allow");
    for (let index = 0; index < 16; index++) state.control.onToolPermission({
      nativeRequestId: `invalid_${index}`, toolName,
      input: index % 2 ? { ...input, approval_receipt: "forged" }
        : { ...input, arguments: { content: "x".repeat(5_000) } },
    }, state.respond);
    await flush();
    state.control.onToolPermission({ nativeRequestId: "native_recovered", toolName, input }, state.respond);
    await flush();
    expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.writes.at(-1)).toEqual({ behavior: "allow", updatedInput: input });
    state.control.close();
  });

  it("denies the native call and resolves the pending UI after an uncertain Platform decision failure", async () => {
    const state = fixture();
    state.decide.mockImplementation(async (_run, _id, decision) => {
      if (decision === "approve") throw new Error("Synthetic network loss after commit");
      return {};
    });
    state.control.onToolPermission({ nativeRequestId: "native_1", toolName, input }, state.respond);
    await flush();
    await expect(state.control.submit(approvalId, "approve", {
      chatId: "chat_owner", clientRequestId: "req_1", platformApprovalProof: "signed-fixture",
    })).rejects.toThrow();
    expect(state.decide).toHaveBeenCalledWith("run_owner", approvalId, "cancel");
    expect(state.writes).toEqual([{ behavior: "deny", message: "Custom MCP approval is unavailable." }]);
    expect(state.events.at(-1)).toMatchObject({ type: "approval.resolved", approvalId, decision: "cancel" });
    await expect(state.control.submit(approvalId, "approve", {
      chatId: "chat_owner", clientRequestId: "req_1", platformApprovalProof: "signed-fixture",
    })).rejects.toThrow();
    state.control.close();
  });
});
