import { expect, it } from "vitest";
import { input, setup, ready, type NativeChild } from "./claude-native-session-fixture.js";
function tool(child: NativeChild, id: string, name: string, parent?: unknown) {
  if (arguments.length < 4) parent = null;
  child.emitFrame({ type: "assistant", session_id: "native_1", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input: {} }] } });
}
function agent(child: NativeChild, id: string, parent: unknown = null) {
  tool(child, id, "Agent", parent);
  child.emitFrame({ type: "system", subtype: "task_started", session_id: "native_1", task_type: "local_agent", task_id: `agent_${id}`, tool_use_id: id });
}
function permission(child: NativeChild, id: string, name: string, agentId?: string) {
  child.emitFrame({ type: "control_request", request_id: `permission_${id}`, request: { subtype: "can_use_tool", tool_use_id: id, tool_name: name, input: {}, ...(agentId ? { agent_id: agentId } : {}) } });
}
function guard(child: NativeChild, id: string, name: string, agentId?: string) {
  const init = child.frames.find(f => f.request?.subtype === "initialize");
  child.emitFrame({ type: "control_request", request_id: `guard_${id}`, request: { subtype: "hook_callback", callback_id: init.request.hooks.PreToolUse.at(-1).hookCallbackIds[0], tool_use_id: id,
    input: { hook_event_name: "PreToolUse", session_id: "native_1", prompt_id: child.promptId, tool_use_id: id, tool_name: name, tool_input: {}, ...(agentId ? { agent_id: agentId } : {}) } } });
}
it.each(["Write", "mcp__matrix_integrations__execute"])("blocks old background ancestry from recreating %s authority or output in the next phase", async name => {
  const { children, turn } = setup(); const first = turn(); await ready(); agent(children[0]!, "old_agent"); children[0]!.createJob(); children[0]!.result(); await first.promise;
  const next = turn({ ...input("new_phase"), resumeState: { sessionId: "native_1" } }); await ready();
  agent(children[0]!, "nested_old", "old_agent"); tool(children[0]!, "late_tool", name, "nested_old");
  guard(children[0]!, "late_tool", name, "agent_nested_old"); permission(children[0]!, "late_tool", name, "agent_nested_old");
  for (const type of ["assistant", "stream_event", "user"]) children[0]!.emitFrame({ type, parent_tool_use_id: "nested_old", message: { content: [{ type: "text", text: "STALE_OUTPUT" }] } });
  await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id === "guard_late_tool")?.response.response).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(children[0]!.frames.find(f => f.response?.request_id === "permission_late_tool")?.response.response.behavior).toBe("deny");
  expect(next.output.some(f => f.request_id === "permission_late_tool" || f.parent_tool_use_id === "nested_old" || f.parent_tool_use_id === "old_agent")).toBe(false);
  children[0]!.result(); await next.promise;
});
it.each([false, true])("proven current tool reaches native permissions without host approval; delegated=%s", async delegated => {
  const { children, turn } = setup(); const phase = turn(); await ready();
  if (delegated) agent(children[0]!, "current_agent");
  tool(children[0]!, "current_tool", "Write", delegated ? "current_agent" : null);
  guard(children[0]!, "current_tool", "Write", delegated ? "agent_current_agent" : undefined);
  permission(children[0]!, "current_tool", "Write", delegated ? "agent_current_agent" : undefined); await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id === "guard_current_tool")?.response.response).toEqual({});
  expect(phase.output.some(f => f.request_id === "permission_current_tool")).toBe(true);
  expect(children[0]!.frames.some(f => f.response?.request_id === "permission_current_tool")).toBe(false);
  children[0]!.result(); await phase.promise;
});
it.each([undefined, 3, "missing_parent", "cycle"])("cannot treat malformed or unrooted ancestry as a new root: %s", async parent => {
  const { children, turn } = setup(); const phase = turn(); await ready();
  if (parent === "cycle") { agent(children[0]!, "cycle_a", "cycle_b"); agent(children[0]!, "cycle_b", "cycle_a"); }
  tool(children[0]!, "invalid_root", "Write", parent === "cycle" ? "cycle_a" : parent);
  permission(children[0]!, "invalid_root", "Write"); await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id === "permission_invalid_root")?.response.response.behavior).toBe("deny");
  expect(phase.output.some(f => f.request_id === "permission_invalid_root")).toBe(false);
  children[0]!.result(); await phase.promise;
});
it("denies requests without observed tool IDs and tools arriving before the phase prompt is bound", async () => {
  const { children, turn } = setup(); const phase = turn(); children[0]!.autoMcpAck = false; await ready();
  tool(children[0]!, "before_prompt", "Write"); permission(children[0]!, "before_prompt", "Write");
  children[0]!.emitFrame({ type: "control_request", request_id: "missing_tool_id", request: { subtype: "can_use_tool", tool_name: "Write", input: {} } }); await ready();
  for (const id of ["permission_before_prompt", "missing_tool_id"]) expect(children[0]!.frames.find(f => f.response?.request_id === id)?.response.response.behavior).toBe("deny");
  children[0]!.ack(children[0]!.frames.find(f => f.request?.subtype === "mcp_set_servers").request_id); await ready(); children[0]!.result(); await phase.promise;
});

it("preserves proven ordinary delegated Bash when no B routines source is registered", async () => {
  const { children, turn } = setup(); const phase = turn(); await ready(); agent(children[0]!, "delegate");
  children[0]!.emitFrame({ type: "assistant", parent_tool_use_id: "delegate", message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "git status" } }] } });
  const init = children[0]!.frames.find(f => f.request?.subtype === "initialize");
  children[0]!.emitFrame({ type: "control_request", request_id: "no_b_bash", request: { subtype: "hook_callback", callback_id: init.request.hooks.PreToolUse[0].hookCallbackIds[0], tool_use_id: "bash",
    input: { hook_event_name: "PreToolUse", session_id: "native_1", prompt_id: children[0]!.promptId, agent_id: "agent_delegate", tool_use_id: "bash", tool_name: "Bash", tool_input: { command: "git status" } } } }); await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id === "no_b_bash")?.response.response).toEqual({});
  children[0]!.result(); await phase.promise;
});
it("stops malformed permission request identities even when their tool proof is valid", async () => {
  const { children, turn } = setup(); const phase = turn(); await ready(); tool(children[0]!, "valid", "Write");
  children[0]!.emitFrame({ type: "control_request", request_id: 3, request: { subtype: "can_use_tool", tool_use_id: "valid", tool_name: "Write", input: {} } }); await ready();
  expect(children[0]!.kill).toHaveBeenCalledOnce(); await expect(phase.promise).rejects.toMatchObject({ kind: "invalid_output" });
});
