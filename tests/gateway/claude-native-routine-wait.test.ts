import { afterEach, expect, it, vi } from "vitest";
import { ROUTINE_CLI_NATIVE_TIMEOUT_MS } from "@matrix-os/contracts/routine-cli";
import { createClaudeNativeSessionControl } from "../../packages/gateway/src/chat/claude-native-session-control.js";
import { createClaudeRoutineHook } from "../../packages/gateway/src/chat/claude-routine-hook.js";
import type { NativeRecord } from "../../packages/gateway/src/chat/claude-native-session-jobs.js";

interface HookRegistration { matcher?: string; hookCallbackIds: string[]; timeout: number }
interface WrittenControl {
  type: string; request_id: string;
  request: { subtype: string; hooks?: { UserPromptSubmit: HookRegistration[]; PreToolUse: HookRegistration[] } };
  response?: { request_id: string; response: { hookSpecificOutput?: { permissionDecision: string } } };
}
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.useRealTimers();
});
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

/** Keep the actual producer/registrar boundary real; only native transport ACKs are fixtures. */
function bridge() {
  const nativeFrames: WrittenControl[] = [], routineFrames: WrittenControl[] = [];
  const order: string[] = [], failures = vi.fn();
  let currentHook: ReturnType<typeof createClaudeRoutineHook> | undefined;
  const control = createClaudeNativeSessionControl({ timeoutMs: 10_000,
    send: async value => {
      const frame = value as WrittenControl; nativeFrames.push(frame); order.push(frame.request.subtype);
      queueMicrotask(() => {
        order.push(`ack:${frame.request.subtype}`);
        control.handle({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
          response: frame.request.subtype === "initialize" ? { hooks_applied: true, claude_code_version: "2.1.317" }
            : { added: [], removed: [], errors: {} } } });
      });
    },
    emit: frame => { order.push("phase-ack"); currentHook?.handle(frame); },
  });
  closers.push(async () => control.close());
  function phase(execute: Parameters<typeof createClaudeRoutineHook>[0]["execute"] = async () => "/bin/cat -- '/tmp/display'") {
    const source = new AbortController(), input = vi.fn(async () => { order.push("input"); });
    const hook = createClaudeRoutineHook({ signal: source.signal, fail: failures, startInput: input, execute,
      write: async raw => {
        const frame = JSON.parse(raw) as WrittenControl; routineFrames.push(frame);
        if (frame.request?.subtype === "initialize") await control.registerPhase(frame as unknown as NativeRecord, {});
      },
    });
    currentHook = hook;
    closers.push(async () => { source.abort(); await hook.close(); });
    return { hook, source, input };
  }
  function tool(hook: ReturnType<typeof createClaudeRoutineHook>, toolId = "routine_tool", requestId = "routine_request") {
    hook.handle({ type: "system", subtype: "init", claude_code_version: "2.1.317", tools: ["Bash"] });
    hook.handle({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: toolId, name: "Bash" } } });
    const remapped = control.remapBash({ type: "control_request", request_id: requestId,
      request: { subtype: "hook_callback", callback_id: control.bashCallbackId, tool_use_id: toolId,
        input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: toolId,
          tool_input: { command: "matrix routines list" }, permission_mode: "default" } } });
    expect(remapped).toBeDefined(); hook.handle(remapped);
  }
  return { control, nativeFrames, routineFrames, order, failures, phase, tool };
}

it("registers the actual 30-minute routine hook before one original input, with one physical initialize", async () => {
  const b = bridge(), phase = b.phase();
  await expect(phase.hook.start()).resolves.toBeUndefined(); await flush();
  const initialize = b.nativeFrames.filter(frame => frame.request.subtype === "initialize");
  expect(initialize).toHaveLength(1);
  expect(initialize[0]!.request.hooks!.PreToolUse.find(hook => hook.matcher === "Bash")!.timeout).toBe(ROUTINE_CLI_NATIVE_TIMEOUT_MS / 1000);
  expect(initialize[0]!.request.hooks!.UserPromptSubmit[0]!.timeout).toBe(120);
  expect(initialize[0]!.request.hooks!.PreToolUse.find(hook => hook.matcher === ".*")!.timeout).toBe(10);
  expect(b.order).toEqual(["initialize", "ack:initialize", "mcp_set_servers", "ack:mcp_set_servers", "phase-ack", "input"]);
  expect(phase.input).toHaveBeenCalledOnce(); expect(b.failures).not.toHaveBeenCalled();
});

it("installs the full Bash budget even when retained preparation precedes routine registration", async () => {
  const b = bridge(); await b.control.prepare({});
  const actual = b.nativeFrames.find(frame => frame.request.subtype === "initialize")!;
  expect(actual.request.hooks!.PreToolUse.find(hook => hook.matcher === "Bash")!.timeout).toBe(ROUTINE_CLI_NATIVE_TIMEOUT_MS / 1000);
  const phase = b.phase(); await phase.hook.start(); await flush();
  expect(b.nativeFrames.filter(frame => frame.request.subtype === "initialize")).toHaveLength(1);
  expect(phase.input).toHaveBeenCalledOnce();
});

it("remaps a subsequent actual phase without another initialize or reviving its closed source", async () => {
  const b = bridge(), firstExecution = vi.fn(async () => "first-display");
  const first = b.phase(firstExecution); await first.hook.start();
  const oldCallback = b.control.phaseBashCallbackId;
  first.source.abort(); await first.hook.close(); b.control.beginPhase();
  expect(b.control.remapBash({ request: { callback_id: b.control.bashCallbackId } })).toBeUndefined();
  const nextExecution = vi.fn(async () => "next-display"), next = b.phase(nextExecution);
  await next.hook.start(); await flush();
  expect(b.control.phaseBashCallbackId).not.toBe(oldCallback);
  expect(b.nativeFrames.filter(frame => frame.request.subtype === "initialize")).toHaveLength(1);
  expect(first.input).toHaveBeenCalledOnce(); expect(next.input).toHaveBeenCalledOnce();
  b.tool(next.hook); await flush();
  expect(nextExecution).toHaveBeenCalledOnce(); expect(firstExecution).not.toHaveBeenCalled();
});

it.each(["source", "native-cancel"] as const)("holds the correlated callback past 120 seconds and fences late completion after %s", async kind => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let active!: AbortSignal, release!: (value: string) => void;
  const b = bridge(), phase = b.phase(async (_command, signal) => {
    active = signal; return new Promise(resolve => { release = resolve; });
  });
  await phase.hook.start(); b.tool(phase.hook); await flush();
  await vi.advanceTimersByTimeAsync(121_000);
  expect(active.aborted).toBe(false);
  expect(b.routineFrames.filter(frame => frame.type === "control_response")).toHaveLength(0);
  if (kind === "source") phase.source.abort();
  else phase.hook.handle({ type: "control_cancel_request", request_id: "routine_request" });
  await flush(); expect(active.aborted).toBe(true);
  release("late-display"); await flush();
  expect(b.routineFrames.filter(frame => frame.type === "control_response")).toHaveLength(0);
  expect(phase.input).toHaveBeenCalledOnce();
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, ROUTINE_CLI_NATIVE_TIMEOUT_MS / 1000 + 1])(
  "rejects invalid phase timeout %s before native initialization", async timeout => {
    const b = bridge();
    await expect(b.control.registerPhase({ type: "control_request", request_id: "invalid_phase", request: { subtype: "initialize",
      hooks: { PreToolUse: [{ matcher: "Bash", hookCallbackIds: ["invalid_callback"], timeout }] } } }, {})).rejects.toThrow("Native phase hook registration unavailable");
    expect(b.nativeFrames).toHaveLength(0);
  },
);

it("does not extend the independent native control ACK deadline", async () => {
  vi.useFakeTimers(); const sent = vi.fn(async () => {});
  const control = createClaudeNativeSessionControl({ timeoutMs: 10_000, send: sent, emit: () => {} });
  closers.push(async () => control.close());
  const prepared = control.prepare({}), rejected = expect(prepared).rejects.toThrow("Native control timed out");
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect(sent).toHaveBeenCalledOnce();
});
