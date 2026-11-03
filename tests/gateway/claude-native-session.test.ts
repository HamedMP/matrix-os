import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeNativeSessionPool, type ClaudeNativeSessionPool } from "../../packages/gateway/src/chat/claude-native-session.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

const input = (runId = "run_1", chatId = "chat_1"): CanonicalProviderRunInput => ({
  owner: { type: "personal", ownerId: "owner_1" }, chatId, turnId: `cturn_${runId}`, runId,
  prompt: "create a native task", parts: [{ type: "text", text: "create a native task" }],
  selection: { instanceId: "claude_code_default", model: "haiku", options: [] },
  interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal,
});
class NativeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); frames: any[] = []; ended = false;
  initialized = false; autoMcpAck = true; version = "2.1.317";
  promptId = "";
  stdin = Object.assign(new EventEmitter(), {
    write: (raw: string, callback?: (error?: Error | null) => void) => {
      const frame = JSON.parse(raw); this.frames.push(frame); callback?.();
      if (frame.type === "control_request" && frame.request.subtype === "initialize") queueMicrotask(() => {
        this.emitFrame({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
          response: { hooks_applied: true, claude_code_version: this.version } } });
        if (!this.initialized) { this.initialized = true; this.emitFrame({ type: "system", subtype: "init", session_id: "native_1", claude_code_version: this.version, tools: ["Bash", "CronCreate", "CronList", "CronDelete"] }); }
      });
      if (frame.type === "control_request" && frame.request.subtype === "mcp_set_servers" && this.autoMcpAck) queueMicrotask(() => this.ack(frame.request_id));
      if (frame.type === "user") queueMicrotask(() => {
        const init = this.frames.find(f => f.request?.subtype === "initialize");
        this.promptId = `foreground_${this.frames.filter(f => f.type === "user").length}`;
        this.prompt(`request_${this.promptId}`, this.promptId, frame.message.content);
      });
      return true;
    },
    end: () => { this.ended = true; queueMicrotask(() => this.exit()); },
  });
  kill = vi.fn((_signal: NodeJS.Signals) => { queueMicrotask(() => this.exit(null, "SIGTERM")); });
  emitFrame(frame: unknown) { this.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`)); }
  ack(requestId: string) { this.emitFrame({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { added: ["matrix-integrations"], removed: [], errors: {} } } }); }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) { this.emit("exit", code, signal); this.emit("close", code, signal); }
  createJob() {
    this.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool_cron", name: "CronCreate", input: { cron: "* * * * *", prompt: "native scheduled prompt", recurring: true } }] } });
    this.emitFrame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool_cron", content: "Scheduled recurring job abcdef01 (Every minute). Session-only." }] } });
  }
  result() { this.emitFrame({ type: "result", session_id: "native_1", subtype: "success", result: "done" }); }
  prompt(requestId = "tick_1", promptId = "prompt_1", prompt = "native scheduled prompt") {
    const init = [...this.frames].reverse().find(f => f.request?.subtype === "initialize");
    const callback = init.request.hooks.UserPromptSubmit.at(-1).hookCallbackIds[0];
    this.emitFrame({ type: "control_request", request_id: requestId, request: { subtype: "hook_callback", callback_id: callback,
      tool_use_id: `hook_${promptId}`, input: { hook_event_name: "UserPromptSubmit", session_id: "native_1", prompt_id: promptId, prompt } } });
  }
  toolHook(toolName: string, toolId: string, toolInput: unknown, promptId = this.promptId) {
    const init = this.frames.find(f => f.request?.subtype === "initialize");
    const hook = init.request.hooks.PreToolUse.find((h: any) => toolName === "Bash" ? h.matcher === "Bash" : h.matcher.includes("CronCreate"));
    this.emitFrame({ type: "control_request", request_id: `callback_${toolId}_${promptId}`, request: { subtype: "hook_callback", callback_id: hook.hookCallbackIds[0],
      tool_use_id: toolId, input: { hook_event_name: "PreToolUse", session_id: "native_1", prompt_id: promptId, tool_name: toolName, tool_use_id: toolId, tool_input: toolInput } } });
  }
}
const pools: ClaudeNativeSessionPool[] = [];
afterEach(async () => { await Promise.allSettled(pools.splice(0).map(p => p.close())); vi.useRealTimers(); });
function setup(options: Parameters<typeof createClaudeNativeSessionPool>[0] = {}) {
  const children: NativeChild[] = [];
  const spawnFn = vi.fn<CanonicalCliSpawn>(() => { const child = new NativeChild(); children.push(child); return child; });
  const scheduled = vi.fn(async () => undefined);
  const pool = createClaudeNativeSessionPool({ protocolQualified: true, onScheduledPhase: scheduled, ...options }); pools.push(pool);
  function turn(i = input(), overrides: Record<string, unknown> = {}, routineCallback?: string) {
    const output: any[] = []; const settled = vi.fn(); let end: (() => void) | undefined;
    let writeFrame: ((raw: string) => Promise<void>) | undefined;
    const user = () => { void writeFrame?.(`${JSON.stringify({ type: "user", session_id: "", message: { role: "user", content: i.prompt } })}\n`).catch(() => undefined); };
    const promise = pool.runTurn({ input: i, sourceFingerprint: "source_a", command: "claude", args: ["--print", "--mcp-config", JSON.stringify({ mcpServers: { "matrix-integrations": { command: "matrix-integrations-mcp", args: ["--require-scoped-capability"] } } })],
      cwd: "/safe", env: { HOME: "/owner", MATRIX_AGENT_INTEGRATIONS_TOKEN: i.runId }, replaceEnv: true,
      signal: i.signal, maxStdoutBytes: 1024 * 1024, spawnFn,
      onStart(write, finish) { end = finish; writeFrame = write; if (routineCallback) {
        void write(`${JSON.stringify({ type: "control_request", request_id: `routine_init_${i.runId}`, request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "Bash", hookCallbackIds: [routineCallback], timeout: 120 }] } } })}\n`).catch(() => undefined);
      } else user(); },
      onStdout(chunk) { const d = JSON.parse(chunk.toString()); output.push(d); if (d.response?.request_id === `routine_init_${i.runId}`) user(); if (d.type === "result") end?.(); },
      onSettled: settled, ...overrides });
    void promise.catch(() => undefined);
    return { promise, output, settled };
  }
  return { children, spawnFn, scheduled, pool, turn };
}
const ready = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

it("finishes an ordinary turn only after the actual child closes", async () => {
  const { children, turn } = setup(); const phase = turn(); await ready();
  children[0]!.result(); await expect(phase.promise).resolves.toBeUndefined();
  expect(children[0]!.ended).toBe(true); expect(phase.settled).toHaveBeenCalledOnce();
});
it("ends a canonical phase while retaining only a child with a confirmed native job", async () => {
  const { children, turn, pool } = setup(); const phase = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await phase.promise;
  expect(children[0]!.ended).toBe(false); expect(children[0]!.kill).not.toHaveBeenCalled();
  expect(phase.settled).toHaveBeenCalledOnce(); await pool.close(); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("does not treat model text or a failed CronCreate result as a live job", async () => {
  const { children, turn } = setup(); const phase = turn(); await ready();
  children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "text", text: "Scheduled recurring job abcdef01" }] } });
  children[0]!.result(); await phase.promise; expect(children[0]!.ended).toBe(true);
});
it("reuses the same exact session for a fresh foreground phase and refreshes scoped MCP env", async () => {
  const { children, turn, spawnFn } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  const next = turn({ ...input("run_2"), resumeState: { sessionId: "native_1" } }); await ready();
  expect(spawnFn).toHaveBeenCalledOnce();
  const configs = children[0]!.frames.filter(f => f.request?.subtype === "mcp_set_servers");
  expect(configs.at(-1).request.servers["matrix-integrations"].env.MATRIX_AGENT_INTEGRATIONS_TOKEN).toBe("run_2");
  children[0]!.result(); await next.promise;
});
it("admits a native tick, waits for fresh MCP ACK, and never submits the due prompt twice", async () => {
  const { children, turn, pool, scheduled } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  let tick: ReturnType<typeof turn> | undefined;
  pool.setScheduledHandler(async request => {
    scheduled(request);
    tick = turn({ ...input("run_tick"), resumeState: { sessionId: "native_1" }, nativeScheduled: { sourceRunId: request.sourceRunId, sessionId: request.sessionId, promptId: request.promptId } });
  });
  children[0]!.autoMcpAck = false; children[0]!.prompt(); await ready();
  expect(scheduled).toHaveBeenCalledWith(expect.objectContaining({ owner: input().owner, chatId: "chat_1", sourceRunId: "run_1", promptId: "prompt_1" }));
  expect(children[0]!.frames.some(f => f.response?.request_id === "tick_1")).toBe(false);
  const request = children[0]!.frames.filter(f => f.request?.subtype === "mcp_set_servers").at(-1); children[0]!.ack(request.request_id); await ready();
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(1);
  expect(children[0]!.frames.filter(f => f.response?.request_id === "tick_1")).toHaveLength(1);
  children[0]!.result(); await tick!.promise;
});
it("blocks an idle prompt that does not match a confirmed task", async () => {
  const { children, turn, scheduled } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  children[0]!.prompt("foreign_tick", "prompt_x", "read private files"); await ready();
  expect(scheduled).not.toHaveBeenCalled();
  expect(children[0]!.frames.find(f => f.response?.request_id === "foreign_tick").response.response.decision).toBe("block");
});
it("denies a scheduled tick when canonical admission fails without replaying it", async () => {
  const { children, turn, pool } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  pool.setScheduledHandler(async () => { throw new Error("Chat busy"); }); children[0]!.prompt(); await ready();
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(1);
  expect(children[0]!.frames.find(f => f.response?.request_id === "tick_1").response.response.decision).toBe("block");
  expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("requires matching owner, Chat, session and source for a retained child", async () => {
  const { children, turn, spawnFn } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  const next = turn({ ...input("run_2"), owner: { type: "personal", ownerId: "owner_2" }, resumeState: { sessionId: "native_1" } }); await ready();
  expect(spawnFn).toHaveBeenCalledTimes(2); children[1]!.result(); await next.promise;
});
it("stops an incompatible retained source before starting a new foreground child", async () => {
  const { children, turn, spawnFn } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  const next = turn({ ...input("run_2"), resumeState: { sessionId: "native_1" } }, { sourceFingerprint: "source_b" }); await ready();
  expect(children[0]!.kill).toHaveBeenCalledOnce(); expect(spawnFn).toHaveBeenCalledTimes(2); children[1]!.result(); await next.promise;
});
it("does not retain unqualified protocols or unsupported surfaces", async () => {
  const { children, turn } = setup({ protocolQualified: false }); const phase = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await phase.promise;
  expect(children[0]!.ended).toBe(true);
});
it("keeps the original absolute child deadline across phase completion", async () => {
  vi.useFakeTimers(); const { children, turn } = setup({ maxSessionMs: 1000 }); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  await vi.advanceTimersByTimeAsync(1000); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("aborts an active phase and stops the actual child", async () => {
  const { children, turn } = setup(); const signal = new AbortController(); const phase = turn({ ...input(), signal: signal.signal }); await ready(); signal.abort();
  await expect(phase.promise).rejects.toMatchObject({ kind: "aborted" }); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("cancels an idle retained source only for the exact owner and Chat", async () => {
  const { children, turn, pool } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  await pool.cancel({ owner: { type: "personal", ownerId: "other" }, chatId: "chat_1", runId: "run_1" }); expect(children[0]!.kill).not.toHaveBeenCalled();
  await pool.cancel({ owner: input().owner, chatId: "chat_1", runId: "run_1" }); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("registers a fresh B phase locally without reinitializing or reviving the old callback", async () => {
  const { children, turn } = setup(); const first = turn(input(), {}, "bash_phase_a"); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  const next = turn({ ...input("run_2"), resumeState: { sessionId: "native_1" } }, {}, "bash_phase_b"); await ready();
  expect(children[0]!.frames.filter(f => f.request?.subtype === "initialize")).toHaveLength(1);
  expect(next.output.some(f => f.type === "system" && f.claude_code_version === "2.1.317")).toBe(true);
  children[0]!.emitFrame({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "bash_1", name: "Bash" } } });
  children[0]!.toolHook("Bash", "bash_1", { command: "routines list" }); await ready();
  expect(next.output.find(f => f.request?.input?.tool_use_id === "bash_1").request.callback_id).toBe("bash_phase_b");
  children[0]!.toolHook("Bash", "bash_1", { command: "routines list" }, "foreground_1"); await ready();
  expect(next.output.filter(f => f.request?.input?.tool_use_id === "bash_1")).toHaveLength(1);
  expect(children[0]!.frames.find(f => f.response?.request_id === "callback_bash_1_foreground_1").response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  children[0]!.result(); await next.promise;
});
it("denies CronCreate before effect when source identity is unverified", async () => {
  const { children, turn } = setup(); const phase = turn(input(), { schedulingAllowed: false }); await ready();
  const args = { cron: "* * * * *", prompt: "native scheduled prompt" };
  children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "denied_cron", name: "CronCreate", input: args }] } });
  children[0]!.toolHook("CronCreate", "denied_cron", args); await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id?.startsWith("callback_denied_cron")).response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  children[0]!.result(); await phase.promise; expect(children[0]!.ended).toBe(true);
});
it("denies a new native task at the owner/global cap without evicting an existing task", async () => {
  const { children, turn } = setup({ maxSessions: 1, maxSessionsPerOwner: 1 }); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  const second = turn(input("run_2", "chat_2")); await ready(); const args = { cron: "* * * * *", prompt: "another task" };
  children[1]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "capped_cron", name: "CronCreate", input: args }] } }); children[1]!.toolHook("CronCreate", "capped_cron", args); await ready();
  expect(children[1]!.frames.find(f => f.response?.request_id?.startsWith("callback_capped_cron")).response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(children[0]!.kill).not.toHaveBeenCalled(); children[1]!.result(); await second.promise;
});
it("does not release a phase after a missing MCP replacement ACK", async () => {
  vi.useFakeTimers(); const { children, turn } = setup({ controlTimeoutMs: 50 }); const phase = turn();
  children[0]!.autoMcpAck = false; await ready(); await vi.advanceTimersByTimeAsync(50);
  await expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(0); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("reports cleanup uncertainty instead of pretending a retained child exited", async () => {
  vi.useFakeTimers(); const unconfirmed = vi.fn(), confirmed = vi.fn(); const { children, turn, pool } = setup();
  const phase = turn({ ...input(), onCleanupUnconfirmed: unconfirmed, onCleanupConfirmed: confirmed }); await ready();
  children[0]!.createJob(); children[0]!.result(); await phase.promise; children[0]!.kill.mockImplementation(() => undefined);
  const close = pool.close(); const failure = close.catch(error => error); await vi.advanceTimersByTimeAsync(1250);
  await expect(failure).resolves.toMatchObject({ message: "Native process cleanup unconfirmed" }); expect(unconfirmed).toHaveBeenCalledOnce(); expect(confirmed).not.toHaveBeenCalled();
});
it("stops the exact held child when a scheduled source fingerprint changes", async () => {
  const { children, turn, pool } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  pool.setScheduledHandler(async request => {
    await pool.runTurn({ input: { ...input("run_tick"), resumeState: { sessionId: request.sessionId }, nativeScheduled: { sourceRunId: request.sourceRunId, sessionId: request.sessionId, promptId: request.promptId } }, sourceFingerprint: "changed",
      command: "claude", args: [], cwd: "/safe", env: {}, signal: new AbortController().signal, maxStdoutBytes: 1024, onStdout() {} });
  });
  children[0]!.prompt(); await ready(); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("does not impose an aggregate tool-count failure on ordinary progressing Chat", async () => {
  const { children, turn } = setup(); const phase = turn(); await ready();
  for (let index = 0; index < 600; index++) children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: `read_${index}`, name: "Read", input: { file_path: "/safe/file" } }] } });
  expect(children[0]!.kill).not.toHaveBeenCalled(); children[0]!.result(); await phase.promise;
});
it("closes the actual reused child after a correlated native cancellation removes its last task", async () => {
  const { children, turn } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  const cleanup = turn({ ...input("run_cleanup"), resumeState: { sessionId: "native_1" } }); await ready();
  children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "delete_1", name: "CronDelete", input: { id: "abcdef01" } }] } });
  children[0]!.emitFrame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "delete_1", content: "Cancelled job abcdef01." }] } });
  children[0]!.result(); await cleanup.promise; expect(children[0]!.ended).toBe(true); expect(children[0]!.kill).not.toHaveBeenCalled();
});
it("denies adjacent native versions before CronCreate while leaving ordinary Chat usable", async () => {
  const { children, turn } = setup(); const phase = turn(); children[0]!.version = "2.1.318"; await ready();
  const args = { cron: "* * * * *", prompt: "native scheduled prompt" };
  children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "unqualified_cron", name: "CronCreate", input: args }] } });
  children[0]!.toolHook("CronCreate", "unqualified_cron", args); await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id?.startsWith("callback_unqualified_cron")).response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  children[0]!.result(); await phase.promise; expect(children[0]!.ended).toBe(true);
});
it("fails closed after a native MCP replacement error and never writes the new prompt", async () => {
  const { children, turn } = setup(); const phase = turn(); children[0]!.autoMcpAck = false; await ready();
  const request = children[0]!.frames.find(f => f.request?.subtype === "mcp_set_servers");
  children[0]!.emitFrame({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { errors: { "matrix-integrations": "unavailable" } } } });
  await expect(phase.promise).rejects.toMatchObject({ kind: "startup" }); expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(0);
});

it("denies unexpected idle permission requests and stops the actual retained child", async () => {
  const { children, turn } = setup(); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  children[0]!.emitFrame({ type: "control_request", request_id: "idle_permission", request: {
    subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo stale" },
  } });
  await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id === "idle_permission")?.response.response.behavior).toBe("deny");
  expect(children[0]!.kill).toHaveBeenCalledOnce();
});

it.each([
  { type: "assistant", message: { content: [{ type: "text", text: "unadmitted background result" }] } },
  { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "idle_tool", name: "Bash" } } },
])("stops a retained child that emits unadmitted idle output: $type", async frame => {
  const { children, turn, scheduled } = setup(); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  children[0]!.emitFrame(frame); await ready();
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  expect(scheduled).not.toHaveBeenCalled();
});

it.each([
  {},
  { added: [], removed: [], errors: "unavailable" },
  { added: "matrix-integrations", removed: [], errors: {} },
  { added: [], removed: [], errors: [] },
])("never releases a user prompt on a malformed MCP replacement ACK: %j", async response => {
  const { children, turn } = setup(); const phase = turn(); children[0]!.autoMcpAck = false; await ready();
  const request = children[0]!.frames.find(f => f.request?.subtype === "mcp_set_servers");
  children[0]!.emitFrame({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
  await expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(0);
  expect(children[0]!.kill).toHaveBeenCalledOnce();
});

it("denies duplicate native job prompts before effect and preserves the original job", async () => {
  const { children, turn, scheduled } = setup(); const first = turn(); await ready();
  children[0]!.createJob();
  const duplicate = { cron: "*/2 * * * *", prompt: "native scheduled prompt", recurring: true };
  children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "duplicate_cron", name: "CronCreate", input: duplicate }] } });
  children[0]!.toolHook("CronCreate", "duplicate_cron", duplicate); await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id === "callback_duplicate_cron_foreground_1").response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(children[0]!.kill).not.toHaveBeenCalled();
  children[0]!.result(); await first.promise;
  children[0]!.prompt(); await ready(); expect(scheduled).toHaveBeenCalledOnce();
});

it("reserves accepted CronCreate prompts until their native receipt settles", async () => {
  const { children, turn } = setup(); const phase = turn(); await ready();
  const args = { cron: "* * * * *", prompt: "same pending native prompt" };
  for (const id of ["pending_a", "pending_b"]) {
    children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "CronCreate", input: args }] } });
    children[0]!.toolHook("CronCreate", id, args); await ready();
  }
  const response = (id: string) => children[0]!.frames.find(f => f.response?.request_id === `callback_${id}_foreground_1`).response.response;
  expect(response("pending_a")).toEqual({});
  expect(response("pending_b").hookSpecificOutput.permissionDecision).toBe("deny");
  children[0]!.emitFrame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "pending_a", is_error: true, content: "Native creation failed" }] } });
  children[0]!.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "pending_c", name: "CronCreate", input: args }] } });
  children[0]!.toolHook("CronCreate", "pending_c", args); await ready();
  expect(response("pending_c")).toEqual({});
  children[0]!.result(); await phase.promise;
});
