import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createClaudeRoutineHook } from "../../packages/gateway/src/chat/claude-routine-hook.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import { input, setup, ready, type NativeChild } from "./claude-native-session-fixture.js";

it("finishes an ordinary turn only after the actual child closes", async () => {
  const { children, turn } = setup(); const phase = turn(); await ready();
  children[0]!.result(); await expect(phase.promise).resolves.toBeUndefined();
  expect(children[0]!.ended).toBe(true); expect(phase.settled).toHaveBeenCalledOnce();
});
it("supplies the first MCP configuration only through the qualified control channel", async () => {
  const { children, turn, spawnFn } = setup(); const phase = turn(); await ready();
  expect(spawnFn.mock.calls[0]![1]).not.toContain("--mcp-config");
  expect(children[0]!.frames.filter(f => f.request?.subtype === "mcp_set_servers")).toHaveLength(1);
  expect(children[0]!.frames.find(f => f.request?.subtype === "mcp_set_servers").request.servers["matrix-integrations"].env.MATRIX_AGENT_INTEGRATIONS_TOKEN).toBe("run_1");
  children[0]!.result(); await phase.promise;
});
it("stops an idle retained native child before an unqualified foreground Chat starts", async () => {
  const { children, turn, pool } = setup(); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  let closed = false; children[0]!.once("close", () => { closed = true; });
  const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
    expect(closed).toBe(true);
    const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
      stdin: { write: (_frame: string, cb?: (error?: Error) => void) => { cb?.(); return true; }, end: vi.fn() } });
    queueMicrotask(() => { c.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "ordinary reply", session_id: "native_1" })}\n`)); c.emit("exit", 0, null); });
    return c;
  });
  const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", nativeSessions: pool, spawnFn,
    resolveNativeProtocol: async () => ({ command: "/unqualified/claude", qualified: false }),
    resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "selected-key" }) });
  const events = [];
  for await (const event of adapter.resume!({ ...input("run_2"), resumeState: { sessionId: "native_1" } })) events.push(event);
  expect(children[0]!.kill).toHaveBeenCalledOnce(); expect(spawnFn).toHaveBeenCalledOnce();
  expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
});
it("refuses to retire an active phase without killing it or starting a fallback child", async () => {
  const { children, turn, pool } = setup(); const phase = turn(); await ready();
  await expect(pool.retireIdle({ ...input(), owner: { type: "personal", ownerId: "other" } })).resolves.toBeUndefined();
  await expect(pool.retireIdle(input())).rejects.toThrow("Native session busy");
  const spawnFn = vi.fn<CanonicalCliSpawn>();
  const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", nativeSessions: pool, spawnFn,
    resolveNativeProtocol: async () => ({ command: "/unqualified/claude", qualified: false }),
    resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "selected-key" }) });
  const events = [];
  for await (const event of adapter.resume!({ ...input("run_2"), resumeState: { sessionId: "native_1" } })) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" }); expect(spawnFn).not.toHaveBeenCalled();
  expect(children[0]!.kill).not.toHaveBeenCalled();
  children[0]!.result(); await phase.promise;
});
it("ends a canonical phase while retaining only a child with a confirmed native job", async () => {
  const { children, turn, pool } = setup(); const phase = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await phase.promise;
  expect(children[0]!.ended).toBe(false); expect(children[0]!.kill).not.toHaveBeenCalled();
  expect(phase.settled).toHaveBeenCalledOnce(); await pool.close(); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("drains a retained child at shutdown and refuses its scheduled input in a fresh Gateway pool", async () => {
  const before = setup();
  const initial = before.turn();
  await ready();
  before.children[0]!.createJob();
  before.children[0]!.result();
  await initial.promise;
  expect(before.children[0]!.ended).toBe(false);

  const closed = vi.fn();
  before.children[0]!.once("close", closed);
  await before.pool.close();
  expect(closed).toHaveBeenCalledOnce();
  expect(before.children[0]!.kill).toHaveBeenCalledWith("SIGTERM");

  const after = setup();
  const stale = after.turn({
    ...input("run_after_restart"),
    resumeState: { sessionId: "native_1" },
    nativeScheduled: { sourceRunId: input().runId, sessionId: "native_1", promptId: "11111111-1111-4111-8111-111111111111" },
  });
  await expect(stale.promise).rejects.toThrow("Native session unavailable");
  expect(after.spawnFn).not.toHaveBeenCalled();
  expect(after.scheduled).not.toHaveBeenCalled();
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
  const { children, turn } = setup(); const signal = new AbortController(); const phase = turn({ ...input(), signal: signal.signal });
  const rejected = expect(phase.promise).rejects.toMatchObject({ kind: "aborted" }); await ready(); signal.abort();
  await rejected; expect(children[0]!.kill).toHaveBeenCalledOnce();
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
it("denies project-persistent CronCreate in a session-scoped Chat before the native tool runs", async () => {
  const { children, turn } = setup();
  const phase = turn();
  await ready();
  const child = children[0]!;
  const common = { cron: "* * * * *", prompt: "synthetic schedule", recurring: true };
  for (const [id, durable] of [["durable_cron", true], ["session_cron", false]] as const) {
    const args = { ...common, durable };
    child.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "CronCreate", input: args }] } });
    child.toolHook("CronCreate", id, args);
    await ready();
  }
  const responses = child.frames.filter(frame => frame.type === "control_response");
  expect(responses.find(frame => frame.response?.request_id?.startsWith("callback_durable_cron"))
    ?.response.response.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
  expect(responses.find(frame => frame.response?.request_id?.startsWith("callback_session_cron"))
    ?.response.response).toEqual({});
  child.result();
  await phase.promise;
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
  const rejected = expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  children[0]!.autoMcpAck = false; await ready(); await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(0); expect(children[0]!.kill).toHaveBeenCalledOnce();
});
it("reports cleanup uncertainty instead of pretending a retained child exited", async () => {
  vi.useFakeTimers(); const unconfirmed = vi.fn(), confirmed = vi.fn(); const { children, turn, pool } = setup();
  const phase = turn({ ...input(), onCleanupUnconfirmed: unconfirmed, onCleanupConfirmed: confirmed }); await ready();
  children[0]!.createJob(); children[0]!.result(); await phase.promise; children[0]!.kill.mockImplementation(() => undefined);
  const close = pool.close(); const rejected = expect(close).rejects.toThrow("Native process cleanup unconfirmed"); await vi.advanceTimersByTimeAsync(1250);
  await rejected; expect(unconfirmed).toHaveBeenCalledOnce(); expect(confirmed).not.toHaveBeenCalled();
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
  const { children, turn } = setup(); const phase = turn(); const rejected = expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  children[0]!.autoMcpAck = false; await ready();
  const request = children[0]!.frames.find(f => f.request?.subtype === "mcp_set_servers");
  children[0]!.emitFrame({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { errors: { "matrix-integrations": "unavailable" } } } });
  await rejected; expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(0);
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
  const { children, turn } = setup(); const phase = turn(); const rejected = expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  children[0]!.autoMcpAck = false; await ready();
  const request = children[0]!.frames.find(f => f.request?.subtype === "mcp_set_servers");
  children[0]!.emitFrame({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
  await rejected;
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

const scheduledWakeup = {
  type: "command_lifecycle", command_uuid: "9293c357-94d1-4e5e-a038-12548cbe7125",
  state: "started", wakeup_source: "schedule_wakeup", uuid: "4ab34771-aba6-4733-8aea-aae4d207fa34", session_id: "native_1",
};
it("keeps the captured native schedule wakeup status idle until UserPromptSubmit admits its phase", async () => {
  const { children, turn, pool, scheduled } = setup(); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  let tick: ReturnType<typeof turn> | undefined;
  pool.setScheduledHandler(async request => {
    scheduled(request);
    tick = turn({ ...input("run_tick"), resumeState: { sessionId: request.sessionId },
      nativeScheduled: { sourceRunId: request.sourceRunId, sessionId: request.sessionId, promptId: request.promptId } });
  });
  children[0]!.emitFrame(scheduledWakeup); await ready();
  expect(children[0]!.kill).not.toHaveBeenCalled(); expect(scheduled).not.toHaveBeenCalled();
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(1);
  children[0]!.prompt(); await ready(); expect(scheduled).toHaveBeenCalledOnce();
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(1);
  children[0]!.result(); await tick!.promise;
});
it.each([
  { session_id: "foreign_session" }, { command_uuid: "malformed" }, { uuid: "malformed" },
  { state: "completed" }, { wakeup_source: "unknown" }, { unexpected: "field" },
])("stops malformed or foreign idle command lifecycle status: %j", async override => {
  const { children, turn, scheduled } = setup(); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  children[0]!.emitFrame({ ...scheduledWakeup, ...override }); await ready();
  expect(children[0]!.kill).toHaveBeenCalledOnce(); expect(scheduled).not.toHaveBeenCalled();
});

const scheduledCompletion = { type: "command_lifecycle", command_uuid: scheduledWakeup.command_uuid,
  state: "completed", uuid: "cc66a12f-3eb5-4931-85c8-7aecaee4fd66", session_id: "native_1" };
it("accepts the captured delayed completion only for its observed wakeup and admits the next native tick", async () => {
  const { children, turn, pool, scheduled } = setup(); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  let tick: ReturnType<typeof turn> | undefined; let tickNumber = 0;
  pool.setScheduledHandler(async request => {
    scheduled(request); tickNumber++;
    tick = turn({ ...input(`run_tick_${tickNumber}`), resumeState: { sessionId: request.sessionId },
      nativeScheduled: { sourceRunId: request.sourceRunId, sessionId: request.sessionId, promptId: request.promptId } });
  });
  children[0]!.emitFrame(scheduledWakeup); children[0]!.prompt(); await ready();
  children[0]!.result(); await tick!.promise;
  children[0]!.emitFrame(scheduledCompletion); await ready();
  expect(children[0]!.kill).not.toHaveBeenCalled(); expect(scheduled).toHaveBeenCalledTimes(1);
  children[0]!.emitFrame({ ...scheduledWakeup, command_uuid: "d573bab6-6e22-46bc-920b-596ef6bc053b" });
  children[0]!.prompt("tick_2", "prompt_2"); await ready();
  expect(scheduled).toHaveBeenCalledTimes(2);
  expect(scheduled.mock.calls[1]![0].sourceRunId).toBe("run_tick_1");
  expect(children[0]!.frames.filter(f => f.type === "user")).toHaveLength(1);
  children[0]!.result(); await tick!.promise;
});
it.each([
  { session_id: "foreign_session" }, { command_uuid: "d573bab6-6e22-46bc-920b-596ef6bc053b" },
  { command_uuid: "malformed" }, { uuid: "malformed" }, { wakeup_source: "schedule_wakeup" },
])("stops malformed or uncorrelated delayed completion: %j", async override => {
  const { children, turn, scheduled } = setup(); const first = turn(); await ready();
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  children[0]!.emitFrame(scheduledWakeup); children[0]!.emitFrame({ ...scheduledCompletion, ...override }); await ready();
  expect(children[0]!.kill).toHaveBeenCalledOnce(); expect(scheduled).not.toHaveBeenCalled();
});
it("clears wakeup correlation when completion is observed during an admitted phase", async () => {
  const { children, turn } = setup(); const first = turn(); await ready(); children[0]!.createJob(); children[0]!.result(); await first.promise;
  children[0]!.emitFrame(scheduledWakeup);
  const next = turn({ ...input("run_next"), resumeState: { sessionId: "native_1" } }); await ready();
  children[0]!.emitFrame(scheduledCompletion); children[0]!.result(); await next.promise;
  children[0]!.emitFrame(scheduledCompletion); await ready(); expect(children[0]!.kill).toHaveBeenCalledOnce();
});

function delegatedTool(child: NativeChild, command = "git status --short", overrides: Record<string, unknown> = {}, taskStarted = true) {
  child.emitFrame({ type: "assistant", session_id: "native_1", parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "delegate_parent", name: "Agent", input: {} }] } });
  if (taskStarted) child.emitFrame({ type: "system", subtype: "task_started", session_id: "native_1", task_type: "local_agent", task_id: "owned_agent", tool_use_id: "delegate_parent" });
  child.emitFrame({ type: "assistant", session_id: "native_1", parent_tool_use_id: "delegate_parent",
    message: { content: [{ type: "tool_use", id: "delegate_bash", name: "Bash", input: { command } }] } });
  const init = child.frames.find(f => f.request?.subtype === "initialize");
  child.emitFrame({ type: "control_request", request_id: "delegated_request", request: { subtype: "hook_callback",
    callback_id: init.request.hooks.PreToolUse.find((h: any) => h.matcher === "Bash").hookCallbackIds[0], tool_use_id: "delegate_bash",
    input: { hook_event_name: "PreToolUse", session_id: "native_1", prompt_id: child.promptId, agent_id: "owned_agent",
      tool_name: "Bash", tool_use_id: "delegate_bash", tool_input: { command }, ...overrides } } });
}
it.each(["git status --short", "matrix routines list"])("delegated %s reaches the unchanged B policy with its agent identity", async command => {
  const frames: any[] = [], execute = vi.fn(async () => "unexpected");
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async raw => { frames.push(JSON.parse(raw)); },
    startInput: async () => {}, fail: () => { throw new Error("unexpected hook failure"); }, execute });
  await hook.start(); const init = frames[0];
  const { children, turn } = setup(); const phase = turn(input(), {}, init.request.hooks.PreToolUse[0].hookCallbackIds[0], init.request_id); await ready();
  delegatedTool(children[0]!, command); await ready();
  const mapped = phase.output.find(f => f.request_id === "delegated_request");
  expect(mapped?.request.input.agent_id).toBe("owned_agent");
  for (const frame of phase.output) hook.handle(frame); await ready();
  const response = frames.find(f => f.response?.request_id === "delegated_request")?.response.response;
  if (command.startsWith("git")) expect(response).toEqual({});
  else expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(execute).not.toHaveBeenCalled(); children[0]!.result(); await phase.promise; await hook.close();
});
it.each([{ agent_id: "foreign_agent" }, { prompt_id: "stale_prompt" }, { session_id: "foreign_session" },
  { tool_use_id: "unobserved_tool" }, { tool_input: { command: "different command" } }])("denies unproven delegated Bash: %j", async fault => {
  const { children, turn } = setup(); const phase = turn(input(), {}, "current_bash"); await ready();
  delegatedTool(children[0]!, "git status --short", fault); await ready();
  expect(phase.output.some(f => f.request_id === "delegated_request")).toBe(false);
  expect(children[0]!.frames.find(f => f.response?.request_id === "delegated_request").response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  children[0]!.result(); await phase.promise;
});

it("requires native task_started provenance and clears old delegated proof at the next phase", async () => {
  const { children, turn } = setup(); const first = turn(input(), {}, "phase_a"); await ready();
  delegatedTool(children[0]!, "git status --short", {}, false); await ready();
  expect(first.output.some(f => f.request_id === "delegated_request")).toBe(false);
  const denied = children[0]!.frames.find(f => f.response?.request_id === "delegated_request");
  expect(denied.response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  delegatedTool(children[0]!); await ready(); // Establish valid old-phase proof before the lifecycle fence.
  children[0]!.createJob(); children[0]!.result(); await first.promise;
  const next = turn({ ...input("run_next"), resumeState: { sessionId: "native_1" } }, {}, "phase_b"); await ready();
  children[0]!.emitFrame({ type: "system", subtype: "task_started", session_id: "native_1", task_type: "local_agent", task_id: "owned_agent", tool_use_id: "delegate_parent" });
  children[0]!.emitFrame({ type: "control_request", request_id: "late_delegated", request: { subtype: "hook_callback", callback_id: "phase_a", tool_use_id: "delegate_bash",
    input: { hook_event_name: "PreToolUse", session_id: "native_1", prompt_id: children[0]!.promptId, agent_id: "owned_agent", tool_name: "Bash", tool_use_id: "delegate_bash", tool_input: { command: "git status --short" } } } }); await ready();
  expect(next.output.some(f => f.request_id === "late_delegated")).toBe(false);
  expect(children[0]!.frames.find(f => f.response?.request_id === "late_delegated").response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  children[0]!.result(); await next.promise;
});
it("denies delegated native Cron and cannot gain task ownership from its nested success receipt", async () => {
  const { children, turn } = setup(); const phase = turn(input(), {}, "phase_a"); await ready();
  const args = { cron: "* * * * *", prompt: "delegated native task" };
  children[0]!.emitFrame({ type: "assistant", session_id: "native_1", parent_tool_use_id: "delegate_parent", message: { content: [{ type: "tool_use", id: "delegated_cron", name: "CronCreate", input: args }] } });
  const init = children[0]!.frames.find(f => f.request?.subtype === "initialize");
  children[0]!.emitFrame({ type: "control_request", request_id: "delegated_cron_request", request: { subtype: "hook_callback", callback_id: init.request.hooks.PreToolUse.find((h: any) => h.matcher === ".*").hookCallbackIds[0], tool_use_id: "delegated_cron",
    input: { hook_event_name: "PreToolUse", session_id: "native_1", prompt_id: children[0]!.promptId, agent_id: "owned_agent", tool_name: "CronCreate", tool_use_id: "delegated_cron", tool_input: args } } }); await ready();
  expect(children[0]!.frames.find(f => f.response?.request_id === "delegated_cron_request").response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  children[0]!.emitFrame({ type: "user", parent_tool_use_id: "delegate_parent", message: { content: [{ type: "tool_result", tool_use_id: "delegated_cron", content: "Scheduled recurring job abcdef01 (Every minute)." }] } });
  children[0]!.result(); await phase.promise; expect(children[0]!.ended).toBe(true);
});
