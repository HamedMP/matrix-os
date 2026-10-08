import { describe, expect, it, vi } from "vitest";
import { createCodexCanonicalTools, freezeCodexCanonicalInventory, canonicalCodexJson, invokeCodexCanonicalAction } from "../../packages/gateway/src/coding-agents/codex-canonical-tools.mjs";

const policy = { revision: "r1", actionMode: "safe_reads", workspaceScope: "owner", tools: ["matrix_list_apps"], delegation: false };
const inventory = [{ toolId: "matrix_list_apps", schemaRevision: "v1", description: "List apps", effect: "read", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const identity = { owner: { type: "personal", ownerId: "u1" }, chatId: "chat_1", runId: "run_1" };
const call = { id: 42, method: "item/tool/call", params: { threadId: "native1", turnId: "turn1", callId: "call1", tool: "matrix_list_apps", arguments: {} } };
function setup(p = policy) {
  const send = vi.fn(); const persist = vi.fn(async () => undefined);
  const bridge = createCodexCanonicalTools({ executionPolicy: p, inventory, identity, send, persist, current: () => ({ threadId: "native1", turnId: "turn1", active: true }) });
  return { bridge, send, persist };
}
describe("server-owned canonical dynamic tools", () => {
  it("uses the canonical authority's lexical JSON key order, including numeric-looking keys", () => {
    expect(canonicalCodexJson({ "2": "b", "10": "a" })).toBe('{"10":"a","2":"b"}');
  });
  it("invokes E authority once with exact frozen identity/policy and sends only its bounded result", async () => {
    const { bridge, persist } = setup(); await bridge.handle(call);
    const record = persist.mock.calls[1][0];
    const invoke = vi.fn(async () => ({ apps: [{ app: "notes" }] }));
    const sendResult = vi.fn(async () => undefined); const signal = new AbortController().signal;
    await invokeCodexCanonicalAction(record, { ...identity, executionPolicy: policy, inventory, actions: { invoke }, signal }, sendResult);
    expect(invoke).toHaveBeenCalledWith({ ...identity, executionPolicy: policy, actionId: record.actionId, toolId: "matrix_list_apps", arguments: {}, signal });
    expect(sendResult).toHaveBeenCalledWith({ type: "canonical_tool_result", actionId: record.actionId, argumentDigest: record.argumentDigest, inventoryDigest: record.inventoryDigest, result: { success: true, contentItems: [{ type: "inputText", text: '{"apps":[{"app":"notes"}]}' }] } });
    await expect(invokeCodexCanonicalAction({ ...record, arguments: { widened: true } }, { ...identity, executionPolicy: policy, inventory, actions: { invoke }, signal }, sendResult)).rejects.toThrow();
    await expect(invokeCodexCanonicalAction({ ...record, runId: "run_other" }, { ...identity, executionPolicy: policy, inventory, actions: { invoke }, signal }, sendResult)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1); bridge.close();
  });
  it("freezes only exact server inventory and rejects native aliases, duplicate schemas and delegation", () => {
    const frozen = freezeCodexCanonicalInventory(policy, inventory);
    expect(frozen.tools.map(t => t.name)).toEqual(["matrix_list_apps"]);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => freezeCodexCanonicalInventory({ ...policy, tools: ["exec_command"] }, inventory)).toThrow();
    expect(() => freezeCodexCanonicalInventory({ ...policy, delegation: true }, inventory)).toThrow();
    expect(() => freezeCodexCanonicalInventory(policy, [...inventory, ...inventory])).toThrow();
    expect(() => freezeCodexCanonicalInventory({ ...policy, tools: ["matrix_apply_app_files"] }, [{ ...inventory[0], toolId: "matrix_apply_app_files", effect: "files" }])).toThrow();
    expect(freezeCodexCanonicalInventory({ ...policy, actionMode: "conversation_only", tools: [] }, inventory).tools).toEqual([]);
    expect(() => freezeCodexCanonicalInventory({ ...policy, actionMode: "conversation_only" }, inventory)).toThrow();
  });
  it("publishes immutable request identity before execution and returns exact bounded canonical result", async () => {
    const { bridge, send, persist } = setup();
    expect(await bridge.handle(call)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    const event = persist.mock.calls[1][0];
    expect(event).toMatchObject({ type: "matrix.codex.action.requested", toolId: "matrix_list_apps", arguments: {}, ...identity });
    expect(event.argumentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(event.actionId).toMatch(/^action_[a-f0-9]{32}$/);
    expect(await bridge.respond({ type: "canonical_tool_result", actionId: event.actionId, argumentDigest: event.argumentDigest, inventoryDigest: event.inventoryDigest, result: { success: true, contentItems: [{ type: "inputText", text: "Apps: Notes" }] } })).toBe(true);
    expect(send).toHaveBeenCalledWith({ id: 42, result: { success: true, contentItems: [{ type: "inputText", text: "Apps: Notes" }] } });
    expect(await bridge.respond({ type: "canonical_tool_result", actionId: event.actionId, argumentDigest: event.argumentDigest, inventoryDigest: event.inventoryDigest, result: { success: true, contentItems: [] } })).toBe(false);
    bridge.close();
  });
  it.each([
    { ...call, method: "item/commandExecution/requestApproval" },
    { ...call, params: { ...call.params, threadId: "other" } },
    { ...call, params: { ...call.params, turnId: "stale" } },
    { ...call, params: { ...call.params, tool: "matrix_apply_app_files" } },
    { ...call, params: { ...call.params, namespace: "evil" } },
    { ...call, params: { ...call.params, arguments: { command: "rm -rf" } } },
  ])("rejects requests before provider/native/canonical dispatch", async request => {
    const { bridge, send, persist } = setup();
    expect(await bridge.handle(request)).toBe(true);
    expect(send.mock.calls[0][0]).toHaveProperty("error");
    expect(persist).not.toHaveBeenCalled(); bridge.close();
  });
  it("denies mutated, oversized and stale control responses without consuming valid identity", async () => {
    const { bridge, send, persist } = setup(); await bridge.handle(call);
    const event = persist.mock.calls[1][0];
    const frame = { type: "canonical_tool_result", actionId: event.actionId, argumentDigest: event.argumentDigest, inventoryDigest: event.inventoryDigest, result: { success: true, contentItems: [{ type: "inputText", text: "ok" }] } };
    expect(await bridge.respond({ ...frame, argumentDigest: "0".repeat(64) })).toBe(false);
    expect(await bridge.respond({ ...frame, inventoryDigest: "0".repeat(64) })).toBe(false);
    expect(await bridge.respond({ ...frame, result: { success: true, contentItems: [{ type: "inputText", text: "x".repeat(65537) }] } })).toBe(false);
    expect(send).not.toHaveBeenCalled(); bridge.close();
    expect(await bridge.respond(frame)).toBe(false);
  });
});
