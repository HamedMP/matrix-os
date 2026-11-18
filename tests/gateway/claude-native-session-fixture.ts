import { EventEmitter } from "node:events";
import { afterEach, vi } from "vitest";
import { createClaudeNativeSessionPool, type ClaudeNativeSessionPool } from "../../packages/gateway/src/chat/claude-native-session.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
export const input = (runId = "run_1", chatId = "chat_1"): CanonicalProviderRunInput => ({
  owner: { type: "personal", ownerId: "owner_1" }, chatId, turnId: `cturn_${runId}`, runId,
  prompt: "create a native task", parts: [{ type: "text", text: "create a native task" }],
  selection: { instanceId: "claude_code_default", model: "haiku", options: [] },
  interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal,
});
export class NativeChild extends EventEmitter {
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
  confirmScopeClosed = vi.fn(async () => true);
  emitFrame(frame: any) { if (["assistant", "stream_event", "user"].includes(frame.type)) frame = { session_id: "native_1", parent_tool_use_id: null, ...frame }; this.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`)); }
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
    const hook = init.request.hooks.PreToolUse.find((h: any) => toolName === "Bash" ? h.matcher === "Bash" : h.matcher === ".*");
    this.emitFrame({ type: "control_request", request_id: `callback_${toolId}_${promptId}`, request: { subtype: "hook_callback", callback_id: hook.hookCallbackIds[0],
      tool_use_id: toolId, input: { hook_event_name: "PreToolUse", session_id: "native_1", prompt_id: promptId, tool_name: toolName, tool_use_id: toolId, tool_input: toolInput } } });
  }
}
const pools: ClaudeNativeSessionPool[] = [];
function reportFixtureFailure(error: unknown): void {
  if (!(error instanceof Error)) throw new TypeError("Native test fixture rejected with a non-Error value");
  console.warn("[claude-native-session-test] Asynchronous fixture failure", error.name);
}
afterEach(async () => {
  const results = await Promise.allSettled(pools.splice(0).map(p => p.close()));
  for (const result of results) if (result.status === "rejected") reportFixtureFailure(result.reason);
  vi.useRealTimers();
});
export function setup(options: Parameters<typeof createClaudeNativeSessionPool>[0] = {}) {
  const children: NativeChild[] = [];
  const spawnFn = vi.fn<CanonicalCliSpawn>(() => { const child = new NativeChild(); children.push(child); return child; });
  const scheduled = vi.fn(async () => undefined);
  const pool = createClaudeNativeSessionPool({ protocolQualified: true, onScheduledPhase: scheduled, ...options }); pools.push(pool);
  function turn(i = input(), overrides: Record<string, unknown> = {}, routineCallback?: string, routineInitId = `routine_init_${i.runId}`) {
    const output: any[] = []; const settled = vi.fn(); let end: (() => void) | undefined;
    let writeFrame: ((raw: string) => Promise<void>) | undefined;
    const user = () => {
      if (!writeFrame) throw new Error("Native fixture input writer is unavailable");
      void writeFrame(`${JSON.stringify({ type: "user", session_id: "", message: { role: "user", content: i.prompt } })}\n`).catch(reportFixtureFailure);
    };
    const promise = pool.runTurn({ input: i, sourceFingerprint: "source_a", command: "claude", args: ["--print", "--mcp-config", JSON.stringify({ mcpServers: { "matrix-integrations": { command: "matrix-integrations-mcp", args: ["--require-scoped-capability"] } } })],
      cwd: "/safe", env: { HOME: "/owner", MATRIX_AGENT_INTEGRATIONS_TOKEN: i.runId }, replaceEnv: true,
      signal: i.signal, maxStdoutBytes: 1024 * 1024, spawnFn,
      onStart(write, finish) { end = finish; writeFrame = write; if (routineCallback) {
        void write(`${JSON.stringify({ type: "control_request", request_id: routineInitId, request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "Bash", hookCallbackIds: [routineCallback], timeout: 120 }] } } })}\n`).catch(reportFixtureFailure);
      } else user(); },
      onStdout(chunk) { const d = JSON.parse(chunk.toString()); output.push(d); if (d.response?.request_id === routineInitId) user(); if (d.type === "result") end?.(); },
      onSettled: settled, ...overrides });
    // Some negative cases attach their assertion after advancing the native pump/timers.
    // Report a safe error name immediately while retaining the original rejection for that assertion.
    void promise.catch(reportFixtureFailure);
    return { promise, output, settled };
  }
  return { children, spawnFn, scheduled, pool, turn };
}
export const ready = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
