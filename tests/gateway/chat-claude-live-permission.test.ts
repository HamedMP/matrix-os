import { createClaudePermissionControl } from "../../packages/gateway/src/chat/claude-permission-control.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

type Frame = { type: string; request_id?: string; request?: { subtype: string; mode?: string; settings?: unknown }; response?: { request_id?: string; response: unknown } };

describe("Claude live owner permission control", () => {
  it("waits for native mode and sandbox acknowledgements before releasing a waiting tool", async () => {
    const writes: Frame[] = [];
    const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
      const child = new EventEmitter() as ReturnType<CanonicalCliSpawn>;
      child.stdout = new EventEmitter() as typeof child.stdout;
      child.stderr = new EventEmitter() as typeof child.stderr;
      const emit = (frame: unknown) => queueMicrotask(() => child.stdout!.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`)));
      child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0, null)); return true; });
      child.stdin = { write(chunk: string, callback?: (error?: Error | null) => void) {
        const frame = JSON.parse(chunk) as Frame;
        writes.push(frame);
        callback?.();
        if (frame.type === "user") emit({ type: "control_request", request_id: "native_shell", request: {
          subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" },
        } });
        if (frame.type === "control_request") emit({ type: "control_response", response: {
          subtype: "success", request_id: frame.request_id,
          response: frame.request?.subtype === "set_permission_mode" ? { mode: frame.request.mode } : {},
        } });
        if (frame.type === "control_response" && frame.response?.request_id === "native_shell") emit({ type: "control_request", request_id: "native_shell_2", request: {
          subtype: "can_use_tool", tool_name: "Bash", input: { command: "git status --short" },
        } });
        if (frame.type === "control_response" && frame.response?.request_id === "native_shell_2") {
          emit({ type: "result", subtype: "success", result: "done" });
          queueMicrotask(() => child.emit("exit", 0, null));
        }
        return true;
      }, end() {} } as typeof child.stdin;
      return child;
    });
    const controller = new AbortController();
    const owner = { type: "personal" as const, ownerId: "owner_claude" };
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home", spawnFn, resolveCredentialEnv: async () => ({}),
      customMcpApprovalClient: { verifyIntegrationDecision: vi.fn(async () => true), verifyPermissionMode: vi.fn(async () => true) } as unknown as CustomMcpApprovalClient,
    });
    const events: CanonicalProviderRunEvent[] = [];
    const consuming = (async () => {
      for await (const event of adapter.start({
        owner, chatId: "chat_live", turnId: "cturn_live", runId: "run_live",
        prompt: "Inspect the current directory", parts: [{ type: "text", text: "Inspect the current directory" }],
        selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
        interactionMode: "default", permissionMode: "supervised", signal: controller.signal,
      })) events.push(event);
    })();
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === "approval.requested")).toBe(true));
      const liveAdapter = adapter as typeof adapter & { setPermissionMode?: (input: {
        owner: typeof owner; chatId: string; runId: string; clientRequestId: string; permissionMode: "full_access"; permissionModeProof: string; begin(): Promise<void>; commit(): Promise<void>;
      }) => Promise<void> };
      await liveAdapter.setPermissionMode?.({ owner, chatId: "chat_live", runId: "run_live",
        clientRequestId: "req_live_permission", permissionMode: "full_access", permissionModeProof: "signed-owner-intent", begin: async () => {}, commit: async () => {} });
      expect(writes.filter(frame => frame.type === "control_request").map(frame => frame.request)).toEqual([
        { subtype: "apply_flag_settings", settings: { sandbox: { enabled: false } } },
        { subtype: "set_permission_mode", mode: "bypassPermissions" },
      ]);
      expect(writes.filter(frame => frame.type === "control_response").map(frame => frame.response?.response))
        .toContainEqual({ behavior: "allow", updatedInput: { command: "pwd" } });
      await consuming;
      expect(events.filter(event => event.type === "approval.requested")).toHaveLength(1);
      expect(writes.filter(frame => frame.type === "control_response").map(frame => frame.response?.response))
        .toContainEqual({ behavior: "allow", updatedInput: { command: "git status --short" } });
      expect(spawnFn.mock.calls[0]?.[1]).toContain("--allow-dangerously-skip-permissions");
    } finally {
      controller.abort();
      await consuming;
    }
  });
});


function permissionController(options: { verify?: boolean; reject?: string; commitFails?: boolean; authorityFails?: boolean } = {}) {
  const signal = new AbortController();
  const frames: Array<Record<string, unknown>> = [];
  const abort = vi.fn(() => signal.abort());
  const authority = vi.fn(async () => { if (options.authorityFails) throw new Error("authority"); });
  const allowPending = vi.fn(async () => {});
  const commit = vi.fn(async () => { if (options.commitFails) throw new Error("database"); });
  const control = createClaudePermissionControl({ chatId: "chat_live", runId: "run_live", initialMode: "supervised", enabled: true,
    signal: signal.signal, verify: vi.fn(async () => options.verify !== false), abort, setAuthority: authority, allowPending,
    dispatch: () => false, supervisedSettings: { permissions: { ask: ["Bash"] }, sandbox: { enabled: true } },
    async write(frame) {
      const value = JSON.parse(frame) as { request_id: string; request: { subtype: string; mode?: string } };
      frames.push(value.request);
      queueMicrotask(() => control.handle({ type: "control_response", response: {
        request_id: options.reject === "unmatched" ? "unrelated_native" : value.request_id, subtype: options.reject === value.request.subtype ? "error" : "success",
        response: value.request.subtype === "set_permission_mode" ? { mode: options.reject === "wrong_mode" ? "default" : value.request.mode } : {},
      } }));
    },
  });
  const input = { owner: { type: "personal" as const, ownerId: "owner_live" }, chatId: "chat_live", runId: "run_live",
    clientRequestId: "req_mode", permissionMode: "full_access" as const, permissionModeProof: "signed", begin: async () => {}, commit };
  return { control, input, frames, abort, signal, authority, allowPending, commit };
}

it("rejects unproven changes before touching native authority", async () => {
  const state = permissionController({ verify: false });
  await expect(state.control.change(state.input)).rejects.toThrow();
  expect(state.frames).toEqual([]); expect(state.authority).not.toHaveBeenCalled();
  expect(state.commit).not.toHaveBeenCalled(); expect(state.abort).not.toHaveBeenCalled();
  state.control.close();
});

it.each([{ reject: "apply_flag_settings" }, { reject: "set_permission_mode" }, { reject: "wrong_mode" }, { authorityFails: true }, { commitFails: true }])(
  "aborts and never releases a tool after a partial permission transition: %j", async options => {
    const state = permissionController(options);
    await expect(state.control.change(state.input)).rejects.toThrow();
    expect(state.abort).toHaveBeenCalledOnce(); expect(state.allowPending).not.toHaveBeenCalled();
    await expect(state.control.change(state.input)).rejects.toThrow();
    state.control.close();
  },
);

it("restores exact supervised settings and re-gates tools when switching back", async () => {
  const state = permissionController();
  await state.control.change(state.input);
  expect(state.control.gate({ nativeRequestId: "tool_2", toolName: "Bash", input: {} }, async () => {})).toBe(true);
  await state.control.change({ ...state.input, clientRequestId: "req_back", permissionMode: "supervised" });
  expect(state.frames.slice(-2)).toEqual([
    { subtype: "apply_flag_settings", settings: { permissions: { ask: ["Bash"] }, sandbox: { enabled: true } } },
    { subtype: "set_permission_mode", mode: "default" },
  ]);
  expect(state.authority).toHaveBeenLastCalledWith(false);
  expect(state.control.gate({ nativeRequestId: "tool_3", toolName: "Bash", input: {} }, async () => {})).toBe(false);
  state.control.close();
});

it("deduplicates and removes cancelled native requests while a mode acknowledgement is pending", async () => {
  const signal = new AbortController();
  let acknowledge!: () => void;
  let control!: ReturnType<typeof createClaudePermissionControl>;
  control = createClaudePermissionControl({ chatId: "chat_live", runId: "run_live", initialMode: "supervised", enabled: true,
    signal: signal.signal, verify: async () => true, abort: () => signal.abort(), setAuthority: async () => {}, allowPending: async () => {},
    dispatch: () => false, supervisedSettings: { sandbox: { enabled: true } },
    async write(frame) {
      const value = JSON.parse(frame) as { request_id: string; request: { subtype: string; mode?: string } };
      const respond = () => control.handle({ type: "control_response", response: { request_id: value.request_id, subtype: "success",
        response: value.request.subtype === "set_permission_mode" ? { mode: value.request.mode } : {} } });
      if (value.request.subtype === "set_permission_mode") acknowledge = respond;
      else queueMicrotask(respond);
    },
  });
  const change = control.change({ owner: { type: "personal", ownerId: "owner" }, chatId: "chat_live", runId: "run_live",
    clientRequestId: "req_cancel_queue", permissionMode: "full_access", permissionModeProof: "signed", begin: async () => {}, commit: async () => {} });
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
  const respond = vi.fn(async () => {});
  const request = { nativeRequestId: "cancelled_native", toolName: "Bash", input: { command: "pwd" } };
  for (let duplicate = 0; duplicate < 20; duplicate++) expect(control.gate(request, respond)).toBe(true);
  control.cancel(request.nativeRequestId);
  acknowledge(); await change;
  expect(respond).not.toHaveBeenCalled();
  expect(signal.signal.aborted).toBe(false);
  control.close();
});


it.each([
  ["supervised", "full_access"], ["full_access", "supervised"],
] as const)("keeps the acknowledged %s → %s mode when steering the same Run", async (initialMode, targetMode) => {
  const owner = { type: "personal" as const, ownerId: "owner_steer" };
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
  const issued = vi.spyOn(registry, "issue");
  let attempts = 0, generation = 1;
  const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
    const attempt = ++attempts;
    const child = new EventEmitter() as ReturnType<CanonicalCliSpawn>;
    child.stdout = new EventEmitter() as typeof child.stdout; child.stderr = new EventEmitter() as typeof child.stderr;
    const emit = (frame: unknown) => queueMicrotask(() => child.stdout!.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`)));
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0, null)); return true; });
    child.stdin = { write(chunk: string, callback?: (error?: Error | null) => void) {
      callback?.(); const frame = JSON.parse(chunk) as Frame;
      if (frame.type === "user") {
        emit({ type: "system", subtype: "init", session_id: "native_steer_session" });
        if (attempt === 2) { emit({ type: "result", subtype: "success", result: "done" }); queueMicrotask(() => child.emit("exit", 0, null)); }
      }
      if (frame.type === "control_request") emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
        response: frame.request?.subtype === "set_permission_mode" ? { mode: frame.request.mode } : {} } });
      return true;
    }, end() {} } as typeof child.stdin;
    return child;
  });
  const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn, matrixMcpCapabilityIssuer: registry,
    resolveCredentialEnv: async () => ({}), customMcpApprovalClient: {
      verifyPermissionMode: async () => true, verifyIntegrationDecision: async () => true,
      registerRun: async () => ({ generation }), clearRunApprovals: async () => ({ generation: ++generation, invalidated: 0 }), revokeRun: async () => true,
    } as unknown as CustomMcpApprovalClient });
  const controller = new AbortController(), events: CanonicalProviderRunEvent[] = [];
  const consuming = (async () => { for await (const event of adapter.start({ owner, chatId: "chat_steer", turnId: "cturn_steer", runId: "run_steer",
    prompt: "Work", parts: [{ type: "text", text: "Work" }], selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
    interactionMode: "default", permissionMode: initialMode, signal: controller.signal })) events.push(event); })();
  try {
    await vi.waitFor(() => expect(events.some(event => event.type === "state.updated")).toBe(true));
    await adapter.setPermissionMode!({ owner, chatId: "chat_steer", runId: "run_steer", clientRequestId: "req_mode_steer",
      permissionMode: targetMode, permissionModeProof: "signed", begin: async () => {}, commit: async () => {} });
    await adapter.steer!({ owner, chatId: "chat_steer", runId: "run_steer", turnId: "cturn_steer", clientRequestId: "req_steer",
      prompt: "Continue carefully", parts: [{ type: "text", text: "Continue carefully" }] });
    await consuming;
    const args = spawnFn.mock.calls[1]![1];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(targetMode === "full_access" ? "bypassPermissions" : "default");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!).sandbox.enabled).toBe(targetMode !== "full_access");
    expect(issued.mock.calls.at(-1)?.[0].fullAccess).toBe(targetMode === "full_access");
  } finally { controller.abort(); await consuming; registry.close(); }
});


it("ignores unrelated native acknowledgements and aborts at the bounded deadline", async () => {
  vi.useFakeTimers();
  const state = permissionController({ reject: "unmatched" });
  try {
    const failed = expect(state.control.change(state.input)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001); await failed;
    expect(state.abort).toHaveBeenCalledOnce();
    expect(state.authority).not.toHaveBeenCalled(); expect(state.commit).not.toHaveBeenCalled();
  } finally { state.control.close(); vi.useRealTimers(); }
});

it("cancels a permission transition without committing or releasing queued tools", async () => {
  const state = permissionController({ reject: "unmatched" });
  const failed = expect(state.control.change(state.input)).rejects.toThrow();
  await vi.waitFor(() => expect(state.frames).toHaveLength(1));
  state.signal.abort(); await failed;
  expect(state.commit).not.toHaveBeenCalled(); expect(state.allowPending).not.toHaveBeenCalled();
  state.control.close();
});


it.each(["already_full", "during_upgrade"] as const)("keeps always-ask Custom MCP on the receipt path when %s", async phase => {
  const owner = { type: "personal" as const, ownerId: "owner_custom" }, approvalId = "123e4567-e89b-42d3-a456-426614174001";
  const toolInput = { server_id: "123e4567-e89b-42d3-a456-426614174000", tool: "read", arguments: { path: "/public/fixture" } };
  const prepare = vi.fn(async () => ({ kind: "pending" as const, approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const decide = vi.fn(async () => ({ receipt: "a".repeat(64) })), writes: Frame[] = [];
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
  const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
    const child = new EventEmitter() as ReturnType<CanonicalCliSpawn>;
    child.stdout = new EventEmitter() as typeof child.stdout; child.stderr = new EventEmitter() as typeof child.stderr;
    const emit = (value: unknown) => queueMicrotask(() => child.stdout!.emit("data", Buffer.from(`${JSON.stringify(value)}\n`)));
    const custom = () => emit({ type: "control_request", request_id: "native_custom", request: {
      subtype: "can_use_tool", tool_name: "mcp__matrix-integrations__call_custom_mcp_tool", input: toolInput } });
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0, null)); return true; });
    child.stdin = { write(chunk: string, callback?: (error?: Error | null) => void) {
      callback?.(); const frame = JSON.parse(chunk) as Frame; writes.push(frame);
      if (frame.type === "user") {
        if (phase === "already_full") custom();
        else emit({ type: "control_request", request_id: "native_builtin", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } } });
      }
      if (frame.type === "control_request") {
        if (frame.request?.subtype === "set_permission_mode") custom();
        emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
          response: frame.request?.subtype === "set_permission_mode" ? { mode: frame.request.mode } : {} } });
      }
      if (frame.type === "control_response" && frame.response?.request_id === "native_custom") {
        emit({ type: "result", subtype: "success", result: "done" }); queueMicrotask(() => child.emit("exit", 0, null));
      }
      return true;
    }, end() {} } as typeof child.stdin;
    return child;
  });
  const controller = new AbortController(), events: CanonicalProviderRunEvent[] = [];
  const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn, resolveCredentialEnv: async () => ({}), matrixMcpCapabilityIssuer: registry,
    customMcpApprovalClient: { prepare, decide, registerRun: async () => ({ generation: 1 }), revokeRun: async () => true,
      verifyPermissionMode: async () => true, verifyIntegrationDecision: async () => true } as unknown as CustomMcpApprovalClient });
  const consuming = (async () => { for await (const event of adapter.start({ owner, chatId: "chat_custom", turnId: "cturn_custom", runId: "run_custom", prompt: "Read", parts: [{ type: "text", text: "Read" }],
    selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default", permissionMode: phase === "already_full" ? "full_access" : "supervised", signal: controller.signal })) events.push(event); })();
  try {
    if (phase === "during_upgrade") {
      await vi.waitFor(() => expect(events.some(event => event.type === "approval.requested")).toBe(true));
      await adapter.setPermissionMode!({ owner, chatId: "chat_custom", runId: "run_custom", clientRequestId: "req_custom_mode", permissionMode: "full_access", permissionModeProof: "signed", begin: async () => {}, commit: async () => {} });
    }
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval.requested", approvalId })));
    expect(writes.filter(frame => frame.type === "control_response" && frame.response?.request_id === "native_custom")).toEqual([]);
    await adapter.submitApproval!({ owner, chatId: "chat_custom", runId: "run_custom", approvalId, decision: "approve", clientRequestId: "req_custom_approve", platformApprovalProof: "signed-exact-tool" });
    await consuming;
    expect(decide).toHaveBeenCalledWith("run_custom", approvalId, "approve", { chatId: "chat_custom", clientRequestId: "req_custom_approve", platformApprovalProof: "signed-exact-tool" });
    expect(writes.find(frame => frame.type === "control_response" && frame.response?.request_id === "native_custom")?.response?.response)
      .toEqual({ behavior: "allow", updatedInput: { ...toolInput, approval_receipt: "a".repeat(64) } });
  } finally { controller.abort(); await consuming; registry.close(); }
});


it.each(["supervised", "full_access"] as const)("drains queued tools after a same-mode %s owner operation", async permissionMode => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const begin = vi.fn(() => held);
  const dispatch = vi.fn(() => true), respond = vi.fn(async () => {}), write = vi.fn(async () => {});
  const control = createClaudePermissionControl({ chatId: "chat_same", runId: "run_same", initialMode: permissionMode,
    enabled: true, signal: new AbortController().signal, verify: async () => true, write,
    supervisedSettings: {}, setAuthority: async () => {}, allowPending: async () => {}, dispatch, abort: () => {} });
  const change = control.change({ owner: { type: "personal", ownerId: "owner" }, chatId: "chat_same", runId: "run_same",
    clientRequestId: "req_same", permissionMode, permissionModeProof: "signed", begin, commit: async () => {} });
  await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
  control.gate({ nativeRequestId: "same_builtin", toolName: "Bash", input: {} }, respond);
  control.gate({ nativeRequestId: "same_custom", toolName: "mcp__matrix-integrations__call_custom_mcp_tool", input: {} }, respond);
  release(); await change;
  expect(write).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledTimes(permissionMode === "supervised" ? 2 : 1);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ toolName: "mcp__matrix-integrations__call_custom_mcp_tool" }), respond);
  expect(respond).toHaveBeenCalledTimes(permissionMode === "full_access" ? 1 : 0);
  control.close();
});
